"""End-to-end vocal transcription with the real models (Demucs htdemucs + CREPE tiny) on a short
synthetic song from scripts/eval_vocals.py. Skipped unless the optional extra is installed
(``uv sync --extra vocals``); downloads the Demucs weights on first use. Takes ~10-30 s."""
from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path

import numpy as np
import pytest

from app import vocals
from app.models import VocalNotes

pytestmark = [
    pytest.mark.skipif(not vocals.available(), reason="optional extra 'vocals' is not installed"),
    pytest.mark.filterwarnings("ignore::DeprecationWarning"),
    pytest.mark.filterwarnings("ignore::UserWarning"),
]

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@pytest.fixture(scope="module")
def song(tmp_path_factory: pytest.TempPathFactory):
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    import eval_vocals as ev
    import make_synthetic as synth
    import soundfile as sf

    spec = dataclasses.replace(synth.TEST_SONG, melody=False)
    rng = np.random.default_rng(7)
    acc, _ = synth.render(spec)
    notes = ev.compose(spec, rng, 50, 67)
    voice, f0_true, _ = ev.render_voice(notes, len(acc), False, 25.0, rng)
    mask = np.zeros(len(acc), dtype=bool)
    for n in notes:
        mask[int(n.onset * ev.SR):int(n.offset * ev.SR)] = True
    voice *= np.sqrt(np.mean(acc[mask] ** 2)) / np.sqrt(np.mean(voice[mask] ** 2)) * 10 ** (5 / 20)
    mix = acc + voice
    scale = 0.9 / np.max(np.abs(mix))
    d = tmp_path_factory.mktemp("vocals-song")
    wav = d / "song.wav"
    sf.write(str(wav), (mix * scale).astype(np.float32), ev.SR)
    clean = d / "voice.wav"
    sf.write(str(clean), (voice * scale).astype(np.float32), ev.SR)
    ref = [[n.onset, n.offset, n.midi] for n in notes]
    return {"wav": wav, "clean": clean, "ref": ref, "f0": f0_true, "ev": ev, "dir": d}


def test_pipeline_end_to_end(song) -> None:
    from app.vocals import pipeline
    from app.vocals.audio import decode_stereo

    stems = song["dir"] / "stems"
    seen: list[tuple[float, str]] = []
    tr = pipeline.run(song["wav"], stems, progress=lambda f, m: seen.append((f, m)))
    result = tr.result
    json.dumps(result)  # plain JSON
    model = VocalNotes.from_pipeline(result)
    assert model.engine.startswith("htdemucs + torchcrepe-tiny") and model.range is not None
    assert abs(result["tuningCents"] - 25.0) <= 10.0
    for name in ("vocals", "instruments"):
        audio = decode_stereo(stems / f"{name}.mp3")
        assert audio.shape[0] == 2 and abs(audio.shape[1] / 44100 - len(song["f0"]) * 0.01) < 0.2
    assert [f for f, _ in seen] == sorted(f for f, _ in seen) and seen[-1][0] < 1.0
    assert {m for _, m in seen} >= {"Separating vocals", "Tracking the melody", "Finding notes"}
    m = song["ev"].note_metrics(song["ref"], result["notes"])
    assert m["onF"] >= 0.7 and m["pitch"] >= 0.9, m


def test_pitch_tracker_on_the_clean_voice(song) -> None:
    from app.vocals import pitch, segment
    from app.vocals.audio import decode_stereo, to_pitch_rate

    x16 = to_pitch_rate(decode_stereo(song["clean"]).mean(axis=0))
    energy = pitch.frame_rms_db(x16)
    track = pitch.track(x16, energy, "tiny", "cpu")
    seg = segment.segment(track.midi, track.periodicity, energy)
    fm = song["ev"].frame_metrics(song["f0"], seg.smooth_midi, seg.voiced)
    assert fm["RPA"] >= 0.95 and fm["VR"] >= 0.9, fm


def test_block_separation_is_seamless(song, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.vocals import runtime, separate
    from app.vocals.audio import decode_stereo

    x = decode_stereo(song["wav"])[:, : 44100 * 20]
    dev = runtime.device()

    def collect() -> np.ndarray:
        out = np.zeros(x.shape, dtype=np.float32)
        pos = []

        def sink(offset: int, voc: np.ndarray, inst: np.ndarray) -> None:
            pos.append((offset, voc.shape[1]))
            out[:, offset:offset + voc.shape[1]] = voc

        separate.separate(x, sink, lambda f: None, dev)
        assert sum(n for _, n in pos) == x.shape[1]
        assert all(a + n == b for (a, n), (b, _) in zip(pos, pos[1:]))  # consecutive, no gaps / overlaps
        return out

    whole = collect()
    monkeypatch.setattr(separate, "BLOCK_S", 8.0)  # -> 2 blocks of 10 s with a crossfade at 10 s
    blocks = collect()
    err = 10 * np.log10(np.sum((blocks - whole) ** 2) / np.sum(whole ** 2))
    print(f"block vs whole separation: {err:.1f} dB")
    assert err < -20.0, err


def test_cancel_during_separation_leaves_nothing(song) -> None:
    from app.vocals import pipeline, runtime

    class Stop(Exception):
        pass

    def progress(fraction: float, message: str) -> None:
        if message == "Separating vocals" and fraction > pipeline.SEPARATE[0]:
            raise Stop()  # what the job does on cancel (raises from the progress callback)

    stems = song["dir"] / "stems-cancelled"
    with pytest.raises(Stop):
        pipeline.transcribe(song["wav"], stems, progress)
    assert not [p.name for p in stems.iterdir()]  # no stems, no partial files
    assert runtime._run_lock.acquire(timeout=1)  # the inference lock was released
    runtime._run_lock.release()
