"""Chord engine tests: API contract, label convention, edge cases, accuracy, thread safety,
and numerical equivalence of the fast network / DBN implementations with madmom."""
from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scripts"))

from app.engine import EngineError, analyze, engine_info  # noqa: E402
from app.engine.chords import (ENGINE_QUALITIES, PITCH_NAMES, QUALITIES, Chord, format_label,  # noqa: E402
                               parse_label)

HAS_MADMOM = importlib.util.find_spec("madmom") is not None
LABEL_RE = re.compile(r"^(N|[A-G]#?(|m|7|maj7|m7|dim|aug|sus2|sus4|dim7|m7b5|6|m6|9|add9)(/[A-G]#?)?)$")
RESULT_KEYS = {"duration", "tempo", "timeSignature", "beats", "downbeats", "chords", "key", "waveform", "engine"}
CHORD_KEYS = {"start", "end", "label", "root", "quality", "bass", "confidence"}


# --------------------------------------------------------------------------------------
# fixtures


@pytest.fixture(scope="session")
def synth_song(tmp_path_factory):
    from make_synthetic import TEST_SONG, write_song

    out = tmp_path_factory.mktemp("synth")
    wav, js = write_song(TEST_SONG, out)
    import json

    return wav, json.loads(js.read_text())


@pytest.fixture(scope="session")
def analysis(synth_song):
    wav, _ = synth_song
    progress: list[tuple[float, str]] = []
    res = analyze(str(wav), progress=lambda f, m: progress.append((f, m)))
    return res, progress


def _check_contract(res: dict) -> None:
    assert set(res) == RESULT_KEYS
    dur = res["duration"]
    assert isinstance(dur, float) and dur > 0
    assert isinstance(res["tempo"], float) and res["tempo"] > 0
    assert res["timeSignature"] in (2, 3, 4, 5, 6, 7)
    assert isinstance(res["engine"], str) and res["engine"]
    beats = res["beats"]
    assert beats == sorted(beats) and all(0 <= b <= dur for b in beats)
    assert set(res["downbeats"]) <= set(beats)
    key = res["key"]
    assert set(key) == {"tonic", "mode", "name", "confidence"}
    assert key["tonic"] in PITCH_NAMES and key["mode"] in ("major", "minor")
    assert key["name"] == key["tonic"] + ("m" if key["mode"] == "minor" else "")
    assert 0.0 <= key["confidence"] <= 1.0
    wf = res["waveform"]
    assert len(wf) == 1200 and all(0.0 <= v <= 1.0 for v in wf)
    chords = res["chords"]
    assert chords, "chords must cover the whole file"
    assert chords[0]["start"] == 0.0
    assert chords[-1]["end"] == pytest.approx(dur, abs=1e-6)
    for a, b in zip(chords, chords[1:]):
        assert a["end"] == b["start"], "segments must be contiguous"
        assert a["label"] != b["label"], "identical neighbours must be merged"
    for c in chords:
        assert set(c) == CHORD_KEYS
        assert c["end"] > c["start"]
        assert 0.0 <= c["confidence"] <= 1.0
        assert LABEL_RE.match(c["label"]), c["label"]
        if c["label"] == "N":
            assert c["root"] is None and c["quality"] is None and c["bass"] is None
        else:
            assert c["root"] in PITCH_NAMES and c["quality"] in QUALITIES
            assert c["bass"] is None or (c["bass"] in PITCH_NAMES and c["bass"] != c["root"])
            assert c["label"] == format_label(PITCH_NAMES.index(c["root"]), c["quality"],
                                              PITCH_NAMES.index(c["bass"]) if c["bass"] else None)


# --------------------------------------------------------------------------------------
# vocabulary


def test_engine_info():
    info = engine_info()
    assert isinstance(info["name"], str) and isinstance(info["version"], str)
    feats = info["features"]
    assert isinstance(feats["separation"], bool) and isinstance(feats["downbeats"], bool)
    assert feats["madmom"] == HAS_MADMOM
    assert all(isinstance(v, bool) for v in feats.values())


@pytest.mark.parametrize("quality", list(QUALITIES))
def test_label_roundtrip(quality):
    for root in range(12):
        for bass in (None, (root + 4) % 12):
            label = format_label(root, quality, bass)
            assert LABEL_RE.match(label), label
            assert parse_label(label) == Chord(root, quality, bass)


def test_label_convention_examples():
    assert format_label(1, "min7") == "C#m7"
    assert format_label(7, "maj", 11) == "G/B"
    assert format_label(0, "hdim7") == "Cm7b5"
    assert parse_label("Bb") == Chord(10, "maj")  # flats are accepted and re-spelled
    assert parse_label("N").to_dict() == {"label": "N", "root": None, "quality": None, "bass": None}
    assert set(ENGINE_QUALITIES) <= set(QUALITIES)


# --------------------------------------------------------------------------------------
# full analysis


def test_contract_and_progress(analysis):
    res, progress = analysis
    _check_contract(res)
    fracs = [f for f, _ in progress]
    assert fracs and fracs[-1] == 1.0
    assert all(0.0 <= f <= 1.0 for f in fracs)
    assert fracs == sorted(fracs), "progress must be monotonic"
    assert all(isinstance(m, str) and m for _, m in progress)


def test_rhythm_and_key(analysis, synth_song):
    res, _ = analysis
    _, truth = synth_song
    assert res["tempo"] == pytest.approx(truth["tempo"], rel=0.06)
    assert res["timeSignature"] == 4
    assert res["key"]["name"] == truth["key"]


def test_synthetic_accuracy(analysis, synth_song):
    from eval_engine import score

    res, _ = analysis
    _, truth = synth_song
    sc = score(res["chords"], truth["chords"], truth["duration"])
    assert sc["majmin"] >= 0.85, sc
    assert sc["root"] >= 0.85, sc


def test_dsp_fallback(synth_song):
    from eval_engine import score

    wav, truth = synth_song
    res = analyze(str(wav), options={"backend": "dsp", "unknownOption": 1})
    _check_contract(res)
    assert "dsp" in res["engine"]
    assert score(res["chords"], truth["chords"], truth["duration"])["majmin"] >= 0.8


def test_concurrent_analyses_are_consistent(synth_song, analysis):
    wav, _ = synth_song
    expected = [c["label"] for c in analysis[0]["chords"]]
    results: list = [None] * 3
    errors: list = []

    def work(i: int) -> None:
        try:
            results[i] = [c["label"] for c in analyze(str(wav), options={"separate": True})["chords"]]
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert all(r == expected for r in results)


def test_progress_callback_exception_cancels(synth_song):
    """Raising from the progress callback (how the job runner cancels) must propagate as-is."""
    wav, _ = synth_song

    class Cancelled(Exception):
        pass

    calls = []

    def progress(fraction: float, message: str) -> None:
        calls.append(fraction)
        if fraction >= 0.3:
            raise Cancelled()

    with pytest.raises(Cancelled):
        analyze(str(wav), progress=progress)
    assert calls and max(calls) < 1.0


def test_video_container(synth_song, tmp_path):
    wav, _ = synth_song
    mp4 = tmp_path / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5:d=6", "-i", str(wav),
                    "-t", "6", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(mp4)], check=True)
    res = analyze(str(mp4))
    _check_contract(res)
    assert any(c["label"] != "N" for c in res["chords"])


# --------------------------------------------------------------------------------------
# edge cases


def test_very_short_file(tmp_path):
    path = tmp_path / "short.wav"
    sf.write(str(path), 0.3 * np.sin(2 * np.pi * 440 * np.arange(int(0.3 * 44100)) / 44100), 44100)
    res = analyze(str(path))
    _check_contract(res)
    assert [c["label"] for c in res["chords"]] == ["N"]


def test_silence(tmp_path):
    path = tmp_path / "silence.flac"
    sf.write(str(path), np.zeros((3 * 44100, 2)), 44100)
    res = analyze(str(path))
    _check_contract(res)
    assert [c["label"] for c in res["chords"]] == ["N"]
    assert res["duration"] == pytest.approx(3.0, abs=0.01)


def test_pure_tone_triad_is_not_no_chord(tmp_path):
    t = np.arange(3 * 44100) / 44100
    x = sum(0.2 * np.sin(2 * np.pi * f * t) for f in (220.0, 261.63, 329.63))  # A C E
    path = tmp_path / "am.wav"
    sf.write(str(path), np.stack([x, x], axis=1), 44100)
    res = analyze(str(path))
    _check_contract(res)
    assert "Am" in [c["label"] for c in res["chords"]]


def test_undecodable_file_raises(tmp_path):
    path = tmp_path / "broken.mp3"
    path.write_bytes(np.random.default_rng(0).integers(0, 255, 4000, dtype=np.uint8).tobytes())
    with pytest.raises(EngineError) as info:
        analyze(str(path))
    assert info.value.code == "unsupported_format"


def test_missing_file_raises(tmp_path):
    with pytest.raises(EngineError) as info:
        analyze(str(tmp_path / "nope.wav"))
    assert info.value.code == "not_found"


# --------------------------------------------------------------------------------------
# fast implementations == madmom


@pytest.mark.skipif(not HAS_MADMOM, reason="madmom not installed")
def test_fast_networks_match_madmom():
    from madmom.ml.nn import NeuralNetwork
    from madmom.models import CHORDS_CNN_FEAT, DOWNBEATS_BLSTM

    from app.engine import nn

    rng = np.random.default_rng(1)
    x = np.abs(rng.standard_normal((60, 113))).astype(np.float32)
    ref = NeuralNetwork.load(CHORDS_CNN_FEAT[0])(x.copy())
    np.testing.assert_allclose(nn.load(CHORDS_CNN_FEAT[0])(x), ref, atol=1e-4)
    x = (0.5 * np.abs(rng.standard_normal((300, 314)))).astype(np.float32)
    ref = NeuralNetwork.load(DOWNBEATS_BLSTM[0])(x.copy())
    np.testing.assert_allclose(nn.load(DOWNBEATS_BLSTM[0])(x), ref, atol=1e-4)


@pytest.mark.skipif(not HAS_MADMOM, reason="madmom not installed")
@pytest.mark.parametrize("beats_per_bar", [3, 4])
def test_lean_dbn_matches_madmom(beats_per_bar):
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor

    from app.engine import dbn

    fps, n = 100, 1500
    rng = np.random.default_rng(beats_per_bar)
    act = np.full((n, 2), 0.01) + 0.02 * rng.random((n, 2))
    period = 50  # 120 bpm
    for k, i in enumerate(range(20, n, period)):
        col = 1 if k % beats_per_bar == 0 else 0
        act[i - 1:i + 2, col] = [0.3, 0.8, 0.3]
    ref = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=fps)(act)
    got = dbn.track(act, fps, beats_per_bar=(3, 4))
    np.testing.assert_allclose(got, ref)
    assert int(got[:, 1].max()) == beats_per_bar
