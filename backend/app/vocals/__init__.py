"""Vocal melody transcription — optional extra ``vocals`` (torch, demucs, torchcrepe).

    available() -> bool          the optional dependencies are installed (cheap, no imports)
    transcribe(audio_path, stems_dir, progress=None, options=None) -> dict   (``VocalNotes``)

``transcribe`` separates the track with Demucs ``htdemucs`` (``stems_dir/vocals.mp3`` and
``stems_dir/instruments.mp3`` = bass + other, no drums), tracks the sung pitch with the CREPE network
(torchcrepe weights, 16 kHz, hop 10 ms) and segments it into notes with their real pitch (after
removing the singer's global tuning offset) and duration. See :mod:`app.vocals.segment`.

It is thread-safe: models are loaded once behind a lock, and one separation / pitch inference runs at
a time per process (others wait, still reporting progress). ``progress(fraction, message)`` may raise
to cancel; that exception propagates unchanged. Other failures raise :class:`VocalsError` (``code`` is
an API error code; ``unavailable`` when the extra is not installed).

Options (unknown keys ignored): ``device`` ("cpu" | "mps"), ``crepe`` ("tiny" | "full").
Environment: ``CHORDS_VOCALS_DEVICE``, ``CHORDS_VOCALS_THREADS``, ``CHORDS_VOCALS_CREPE``.
Pre-download the Demucs weights (Docker build): ``python -m app.vocals.warmup``.
"""
from __future__ import annotations

import importlib.util
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Optional

from .errors import VocalsError

__all__ = ["available", "transcribe", "VocalsError", "STEMS", "REQUIRED"]

ProgressFn = Callable[[float, str], None]
STEMS = ("vocals", "instruments")
REQUIRED = ("torch", "demucs", "torchcrepe")


@lru_cache(maxsize=1)
def available() -> bool:
    try:
        return all(importlib.util.find_spec(name) is not None for name in REQUIRED)
    except (ImportError, ValueError):  # pragma: no cover - broken installs
        return False


def transcribe(audio_path: str | Path, stems_dir: str | Path, progress: Optional[ProgressFn] = None,
               options: Optional[dict] = None) -> dict[str, Any]:
    if not available():
        raise VocalsError("Vocal transcription is not installed on this server", code="unavailable")
    from .pipeline import transcribe as _transcribe

    return _transcribe(audio_path, stems_dir, progress, options)
