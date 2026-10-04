"""Chord recognition engine — public API (see docs/SPEC.md "Engine contract").

    engine_info() -> {"name", "version", "features": {...}}
    analyze(audio_path, progress=None, options=None) -> analysis dict (camelCase)

``analyze`` accepts any file ffmpeg can decode and is safe to call from several worker
threads at once (models are loaded once behind a lock and are read-only afterwards).
Failures that are the input's fault raise :class:`EngineError` with an API ``code``
(``unsupported_format`` / ``analysis_failed`` / ...).

Options (unknown keys are ignored):
    separate: bool   accepted for API compatibility; source separation is not bundled,
                     so ``features.separation`` is False and the flag has no effect.
    backend:  "auto" | "neural" | "dsp"   (debug/eval) force a recognizer.
"""
from __future__ import annotations

import importlib.util
from typing import Callable, Optional

from .audio import decode
from .errors import EngineError

__all__ = ["analyze", "engine_info", "EngineError", "ProgressFn", "NAME", "VERSION"]

ProgressFn = Callable[[float, str], None]

NAME = "chords-listener"
VERSION = "1.0.0"


def _has(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def engine_info() -> dict:
    madmom = _has("madmom")
    return {
        "name": NAME,
        "version": VERSION,
        "features": {
            "separation": False,
            "downbeats": True,
            "madmom": madmom,
            "neuralChords": madmom,
            "beatTracking": True,
            "keyDetection": True,
            "extendedChords": True,
            "slashChords": True,
        },
    }


def analyze(audio_path: str, progress: Optional[ProgressFn] = None, options: Optional[dict] = None) -> dict:
    """Analyze an audio/video file. Exceptions raised by ``progress`` propagate unchanged
    (raise from the callback to cancel); other failures raise :class:`EngineError`."""
    from .pipeline import _Progress, analyze_signal, is_callback_error

    prog = _Progress(progress)
    prog(0.0, "Decoding audio")
    x = decode(audio_path, sr=44100)
    try:
        result = analyze_signal(x, progress=prog, options=options)
    except EngineError:
        raise
    except MemoryError as exc:  # pragma: no cover
        raise EngineError("not enough memory to analyze this file", code="analysis_failed") from exc
    except Exception as exc:
        if is_callback_error(exc):
            raise
        raise EngineError(f"chord analysis failed: {exc}", code="analysis_failed") from exc
    backend = result.pop("_backend", "")
    result["engine"] = f"{NAME} {VERSION}" + (f" ({backend})" if backend else "")
    return result
