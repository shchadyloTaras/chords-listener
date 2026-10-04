"""Audio decoding (ffmpeg) and simple signal summaries."""
from __future__ import annotations

import os
import shutil
import subprocess

import numpy as np

from .errors import EngineError

_FFMPEG_FALLBACKS = ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg")


def ffmpeg_binary() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for cand in _FFMPEG_FALLBACKS:
        if os.path.exists(cand):
            return cand
    raise EngineError("ffmpeg is not installed", code="internal")


def decode(path: str, sr: int = 44100, max_seconds: float | None = None) -> np.ndarray:
    """Decode any ffmpeg-readable file (audio or video) to mono float32 at ``sr`` Hz."""
    if not os.path.isfile(path):
        raise EngineError(f"file not found: {path}", code="not_found")
    cmd = [ffmpeg_binary(), "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-sn", "-dn",
           "-map", "0:a:0", "-ac", "1", "-ar", str(sr)]
    if max_seconds is not None:
        cmd += ["-t", f"{max_seconds:.3f}"]
    cmd += ["-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        if "matches no streams" in err or "does not contain any stream" in err:
            raise EngineError("the file has no audio stream", code="unsupported_format")
        lines = err.splitlines()
        detail = lines[0] if lines else "unknown error"
        raise EngineError(f"could not decode audio: {detail}", code="unsupported_format")
    if len(proc.stdout) == 0:
        raise EngineError("the file contains no decodable audio", code="unsupported_format")
    x = np.frombuffer(proc.stdout, dtype=np.float32)  # read-only view, no extra copy
    if not np.all(np.isfinite(x)):
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return x


def waveform_peaks(x: np.ndarray, n: int = 1200) -> list[float]:
    """``n`` peak values in 0..1 (normalized to the loudest bin)."""
    if len(x) == 0:
        return [0.0] * n
    a = np.abs(x).astype(np.float64)
    if len(a) >= n:
        starts = (np.arange(n) * len(a)) // n  # strictly increasing
        peaks = np.maximum.reduceat(a, starts)
    else:  # fewer samples than bins
        peaks = a[(np.arange(n) * len(a)) // n]
    top = float(peaks.max())
    if top <= 1e-6:
        return [0.0] * n
    return [round(float(v), 4) for v in np.clip(peaks / top, 0.0, 1.0)]


def frame_rms_db(x: np.ndarray, sr: int, fps: float, n_frames: int, win: float = 0.2) -> np.ndarray:
    """RMS level (dBFS) of windows centered on frames ``t / fps``."""
    hop = sr / fps
    half = int(win * sr / 2)
    sq = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    centers = (np.arange(n_frames) * hop).astype(np.int64)
    lo = np.clip(centers - half, 0, len(x))
    hi = np.clip(centers + half, 0, len(x))
    energy = (sq[hi] - sq[lo]) / np.maximum(hi - lo, 1)
    return 10.0 * np.log10(energy + 1e-12)
