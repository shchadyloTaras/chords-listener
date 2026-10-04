"""Download and smoke-test the vocal models, e.g. during a Docker build.

    cd backend && uv run --extra vocals python -m app.vocals.warmup [--full]

Fetches the Demucs ``htdemucs`` weights (~84 MB) into the Hugging Face cache (``HF_HOME``, default
``~/.cache/huggingface``; set it to a path inside the image and keep the same value at runtime, plus
``HF_HUB_OFFLINE=1`` so the server never re-checks the hub), loads the CREPE weights that ship
inside the torchcrepe package and runs both on one second of noise on the CPU. Exit code 1 when
the optional dependencies are missing or a model fails.
"""
from __future__ import annotations

import argparse
import os
import sys
import time


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full", action="store_true", help="also load the large CREPE model")
    args = parser.parse_args(argv)

    from . import available

    if not available():
        print("vocals: optional dependencies missing (uv sync --extra vocals)", file=sys.stderr)
        return 1
    import numpy as np
    import torch

    from . import pitch, separate
    from .audio import SR

    started = time.monotonic()
    rng = np.random.default_rng(0)
    x = (0.05 * rng.standard_normal((2, SR))).astype(np.float32)
    got: list[int] = []
    separate.separate(x, lambda offset, voc, inst: got.append(voc.shape[1]), lambda f: None, "cpu")
    assert sum(got) == SR, got
    x16 = (0.1 * np.sin(2 * np.pi * 220.0 * np.arange(16000) / 16000)).astype(np.float32)
    for capacity in ("tiny", "full") if args.full else ("tiny",):
        track = pitch.track(x16, pitch.frame_rms_db(x16), capacity, "cpu")
        voiced = np.isfinite(track.midi)
        assert voiced.any() and abs(float(np.nanmedian(track.midi)) - 57.0) < 0.5, "CREPE sanity check failed"
    cache = os.environ.get("HF_HUB_CACHE") or os.path.join(
        os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    print(f"vocals: models ready in {time.monotonic() - started:.1f}s (torch {torch.__version__}, "
          f"{torch.get_num_threads()} threads); Demucs weights cached in {cache}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
