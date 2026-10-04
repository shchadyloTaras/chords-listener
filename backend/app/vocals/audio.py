"""Audio I/O for the vocal pipeline: ffmpeg decoding to stereo float32 and streamed mp3 encoding.

Only numpy + ffmpeg (no torchaudio I/O). Decoding goes through the same ffmpeg path as the chord
engine, so note times line up with the chords and with the playback mp3.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
from scipy.signal import resample_poly

from ..engine.audio import ffmpeg_binary
from .errors import VocalsError

SR = 44100
PITCH_SR = 16000


def decode_stereo(path: str | Path, sr: int = SR) -> np.ndarray:
    """Decode any ffmpeg-readable file to float32 ``(2, n)`` at ``sr`` Hz (mono files are duplicated)."""
    path = Path(path)
    if not path.is_file():
        raise VocalsError(f"file not found: {path.name}", code="not_found")
    cmd = [ffmpeg_binary(), "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-sn", "-dn",
           "-map", "0:a:0", "-ac", "2", "-ar", str(sr), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not proc.stdout:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise VocalsError(f"could not decode audio: {lines[0] if lines else 'no audio'}", code="unsupported_format")
    x = np.frombuffer(proc.stdout, dtype="<f4")
    x = x[: len(x) - len(x) % 2].reshape(-1, 2).T
    if not np.all(np.isfinite(x)):
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return np.ascontiguousarray(x, dtype=np.float32)


def to_pitch_rate(mono: np.ndarray, sr: int = SR) -> np.ndarray:
    """Resample mono audio to 16 kHz (CREPE's rate) with a polyphase filter."""
    if sr == PITCH_SR:
        return np.asarray(mono, dtype=np.float32)
    g = np.gcd(PITCH_SR, sr)
    return resample_poly(np.asarray(mono, dtype=np.float64), PITCH_SR // g, sr // g).astype(np.float32)


class Mp3Writer:
    """Streams float32 stereo blocks into ffmpeg/libmp3lame (CBR, so browsers seek exactly).

    The file appears at ``path`` only after a successful :meth:`close`; :meth:`abort` (or an error)
    leaves nothing behind.
    """

    def __init__(self, path: str | Path, sr: int = SR, bitrate: str = "160k") -> None:
        self.path = Path(path)
        self._tmp = self.path.with_name(f".{self.path.stem}.partial.mp3")
        self._err = tempfile.TemporaryFile()
        cmd = [ffmpeg_binary(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
               "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "pipe:0",
               "-c:a", "libmp3lame", "-b:a", bitrate, "-map_metadata", "-1", "-f", "mp3", str(self._tmp)]
        self._proc: Optional[subprocess.Popen] = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=self._err
        )

    def write(self, block: np.ndarray) -> None:
        """``block``: float32 ``(2, n)``."""
        if self._proc is None or self._proc.stdin is None:
            raise VocalsError("mp3 writer is closed", code="internal")
        data = np.ascontiguousarray(np.clip(block.T, -1.0, 1.0), dtype="<f4").tobytes()
        try:
            self._proc.stdin.write(data)
        except BrokenPipeError as exc:
            self.abort()
            raise VocalsError("mp3 encoding failed (ffmpeg exited)", code="internal") from exc

    def close(self) -> Path:
        proc, self._proc = self._proc, None
        if proc is None:
            raise VocalsError("mp3 writer is closed", code="internal")
        try:
            if proc.stdin is not None:
                proc.stdin.close()
            code = proc.wait(timeout=120)
        except BaseException:
            proc.kill()
            proc.wait()
            self._tmp.unlink(missing_ok=True)
            self._err.close()
            raise
        self._err.seek(0)
        detail = self._err.read().decode("utf-8", "replace").strip().splitlines()
        self._err.close()
        if code != 0 or not self._tmp.is_file() or self._tmp.stat().st_size == 0:
            self._tmp.unlink(missing_ok=True)
            raise VocalsError(f"mp3 encoding failed: {detail[-1] if detail else code}", code="internal")
        self._tmp.replace(self.path)
        return self.path

    def abort(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            proc.kill()
            proc.wait()
            if proc.stdin is not None:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
        self._tmp.unlink(missing_ok=True)
        if not self._err.closed:
            self._err.close()
