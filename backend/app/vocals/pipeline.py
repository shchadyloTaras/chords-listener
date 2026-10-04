"""Vocal transcription pipeline: decode → Demucs (vocals / instruments) → mp3 stems → CREPE pitch →
note segmentation. Imports torch & co. lazily (only through :mod:`.separate` / :mod:`.pitch`)."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

from . import pitch as pitch_mod
from . import runtime, separate
from .audio import SR, Mp3Writer, decode_stereo, to_pitch_rate
from .errors import VocalsError
from .features import onset_strength
from .segment import SEG_VERSION, Segmentation, segment

log = logging.getLogger("chords.vocals")

ProgressFn = Callable[[float, str], None]
STEMS = ("vocals", "instruments")
VERSION = 1

# overall progress (CPU proportions): decode, separation, stems, pitch, notes
DECODE = (0.0, 0.02)
SEPARATE = (0.02, 0.70)
ENCODE = (0.70, 0.73)
PITCH = (0.73, 0.96)
NOTES = (0.96, 0.99)

_CALLBACK_MARK = "_chords_vocals_from_progress"


def is_callback_error(exc: BaseException) -> bool:
    return bool(getattr(exc, _CALLBACK_MARK, False))


class _Progress:
    """Monotonic progress; exceptions raised by the callback (cancellation) propagate unchanged."""

    def __init__(self, fn: Optional[ProgressFn]) -> None:
        self.fn = fn
        self.last = 0.0
        self.message = ""

    def __call__(self, frac: float, msg: Optional[str] = None) -> None:
        self.last = float(min(max(frac, self.last), 1.0))
        self.message = msg or self.message
        if self.fn is not None:
            try:
                self.fn(self.last, self.message)
            except BaseException as exc:
                try:
                    setattr(exc, _CALLBACK_MARK, True)
                except Exception:  # pragma: no cover
                    pass
                raise

    def span(self, lo_hi: tuple[float, float], msg: str) -> Callable[[float], None]:
        lo, hi = lo_hi
        return lambda f: self(lo + (hi - lo) * min(1.0, max(0.0, float(f))), msg)


def _version(pkg: str) -> str:
    try:
        return version(pkg)
    except PackageNotFoundError:  # pragma: no cover
        return "?"


def engine_name(capacity: str) -> str:
    return f"htdemucs + torchcrepe-{capacity} {_version('torchcrepe')} (seg v{SEG_VERSION})"


@dataclass
class Transcription:
    result: dict[str, Any]
    timings: dict[str, float] = field(default_factory=dict)
    track: Optional[pitch_mod.PitchTrack] = None
    energy_db: Optional[np.ndarray] = None
    onset: Optional[np.ndarray] = None
    seg: Optional[Segmentation] = None
    device: str = "cpu"


def run(audio_path: str | Path, stems_dir: str | Path, progress: Optional[ProgressFn] = None,
        options: Optional[dict] = None) -> Transcription:
    """The whole pipeline. Writes ``stems_dir/vocals.mp3`` and ``stems_dir/instruments.mp3`` and returns
    the ``VocalNotes`` dict (``.result``) plus timings and intermediate features."""
    options = options or {}
    prog = _Progress(progress)
    timings: dict[str, float] = {}
    t0 = time.perf_counter()
    prog(DECODE[0], "Decoding audio")
    x = decode_stereo(audio_path)
    n = x.shape[1]
    if n < SR // 2:
        raise VocalsError("The audio is too short", code="unsupported_format")
    timings["decode"] = time.perf_counter() - t0
    dev = runtime.device(options.get("device"))
    pitch_dev = runtime.device(options.get("pitchDevice") or options.get("device"))
    capacity = str(options.get("crepe") or pitch_mod.capacity_default())
    if capacity not in ("tiny", "full"):
        capacity = "tiny"
    stems_dir = Path(stems_dir)
    stems_dir.mkdir(parents=True, exist_ok=True)

    writers: dict[str, Mp3Writer] = {}
    vocals = np.zeros(n, dtype=np.float32)
    try:
        with runtime.exclusive(lambda: prog(prog.last, "Waiting for another vocal analysis")):
            writers = {name: Mp3Writer(stems_dir / f"{name}.mp3") for name in STEMS}

            def sink(offset: int, voc: np.ndarray, inst: np.ndarray) -> None:
                writers["vocals"].write(voc)
                writers["instruments"].write(inst)
                vocals[offset:offset + voc.shape[1]] = voc.mean(axis=0)

            t = time.perf_counter()
            prog(SEPARATE[0], "Separating vocals")
            separate.separate(x, sink, prog.span(SEPARATE, "Separating vocals"), dev)
            del x
            timings["separate"] = time.perf_counter() - t
            t = time.perf_counter()
            prog(ENCODE[0], "Saving stems")
            for w in writers.values():
                w.close()
            timings["encode"] = time.perf_counter() - t
            t = time.perf_counter()
            x16 = to_pitch_rate(vocals)
            energy = pitch_mod.frame_rms_db(x16)
            prog(PITCH[0], "Tracking the melody")
            track = pitch_mod.track(x16, energy, capacity, pitch_dev, prog.span(PITCH, "Tracking the melody"))
            timings["pitch"] = time.perf_counter() - t
        t = time.perf_counter()
        prog(NOTES[0], "Finding notes")
        onset = onset_strength(x16)
        seg = segment(track.midi, track.periodicity, energy, onset)
        timings["notes"] = time.perf_counter() - t
    except BaseException:
        for w in writers.values():
            w.abort()
        raise
    timings["total"] = time.perf_counter() - t0
    result = {
        "version": VERSION,
        "engine": engine_name(capacity),
        "tuningCents": seg.tuning_cents,
        "notes": [list(r) for r in seg.notes],
        "contour": seg.contour(),
        "range": seg.range(),
    }
    log.info("vocals: %.1fs of audio -> %d notes in %.1fs (%s; %s)", n / SR, len(seg.notes), timings["total"],
             dev, ", ".join(f"{k} {v:.1f}s" for k, v in timings.items()))
    return Transcription(result=result, timings=timings, track=track, energy_db=energy, onset=onset, seg=seg,
                         device=dev)


def transcribe(audio_path: str | Path, stems_dir: str | Path, progress: Optional[ProgressFn] = None,
               options: Optional[dict] = None) -> dict[str, Any]:
    try:
        return run(audio_path, stems_dir, progress, options).result
    except VocalsError:
        raise
    except MemoryError as exc:  # pragma: no cover
        raise VocalsError("not enough memory for vocal separation", code="analysis_failed") from exc
    except BaseException as exc:
        if is_callback_error(exc) or not isinstance(exc, Exception):
            raise
        raise VocalsError(f"vocal transcription failed: {exc}", code="analysis_failed") from exc
