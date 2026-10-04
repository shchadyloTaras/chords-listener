"""Image warmup (backend/Dockerfile): run once at build time so the first request on a fresh Cloud Run
instance is fast.

* analyzes a short synthetic song with the real engine: madmom models are loaded once and numba
  compiles its kernels into ``NUMBA_CACHE_DIR`` (reused at runtime when the CPU matches, otherwise
  recompiled in the background at start-up);
* with ``--vocals`` (or when Demucs is installed): downloads the Demucs ``htdemucs`` weights into the
  torch / Hugging Face caches (``TORCH_HOME`` / ``HF_HOME``);
* checks the tools yt-dlp needs on a server: ffmpeg, ffprobe and the node JS runtime.

Usage (from backend/):  uv run python scripts/warmup.py [--engine] [--vocals]   (no flag = everything)
"""
from __future__ import annotations

import argparse
import importlib.util
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SR = 44100


def synth_song(path: Path, seconds: float = 24.0) -> None:
    """C - Am - F - G at 120 bpm, piano-like partials with a kick on every beat."""
    t = np.arange(int(SR * seconds)) / SR
    chords = [(60, 64, 67), (57, 60, 64), (53, 57, 60), (55, 59, 62)]
    y = np.zeros_like(t)
    for i, start in enumerate(np.arange(0, seconds, 2.0)):
        seg = (t >= start) & (t < start + 2.0)
        tt = t[seg] - start
        env = np.exp(-1.5 * tt)
        for midi in chords[i % 4]:
            f = 440.0 * 2 ** ((midi - 69) / 12)
            for k, amp in enumerate((1.0, 0.5, 0.25, 0.12), start=1):
                y[seg] += amp * env * np.sin(2 * np.pi * f * k * tt)
    for beat in np.arange(0, seconds, 0.5):
        seg = (t >= beat) & (t < beat + 0.08)
        tt = t[seg] - beat
        y[seg] += 0.8 * np.exp(-40 * tt) * np.sin(2 * np.pi * 60 * tt)
    y = 0.8 * y / (np.abs(y).max() + 1e-9)
    sf.write(path, np.stack([y, y], axis=1).astype(np.float32), SR)


def warm_engine() -> None:
    from app.engine import analyze

    with tempfile.TemporaryDirectory() as tmp:
        song = Path(tmp) / "warmup.wav"
        synth_song(song)
        started = time.monotonic()
        result = analyze(str(song))
        labels = [c["label"] for c in result["chords"]][:8]
        print(f"engine warm: {time.monotonic() - started:.1f}s, {result['engine']}, chords {labels}", flush=True)


def warm_vocals() -> None:
    if importlib.util.find_spec("demucs") is None:
        print("vocals: demucs is not installed - skipped", flush=True)
        return
    started = time.monotonic()
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    print(f"vocals: htdemucs weights ready ({type(model).__name__}) in {time.monotonic() - started:.1f}s", flush=True)


def check_tools() -> None:
    missing = [name for name in ("ffmpeg", "ffprobe", "node") if shutil.which(name) is None]
    if missing:
        raise SystemExit(f"missing tools: {', '.join(missing)}")
    from app.sources import YtDlpFetcher, ytdlp_version

    runtimes = YtDlpFetcher(1)._opts().get("js_runtimes")
    if not runtimes:
        raise SystemExit("yt-dlp has no JS runtime (node)")
    print(f"tools: ffmpeg, ffprobe, yt-dlp {ytdlp_version()} with JS runtime {sorted(runtimes)}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine", action="store_true")
    ap.add_argument("--vocals", action="store_true")
    ap.add_argument("--tools", action="store_true")
    args = ap.parse_args()
    everything = not (args.engine or args.vocals or args.tools)
    if everything or args.tools:
        check_tools()
    if everything or args.engine:
        warm_engine()
    if everything or args.vocals:
        warm_vocals()


if __name__ == "__main__":
    main()
