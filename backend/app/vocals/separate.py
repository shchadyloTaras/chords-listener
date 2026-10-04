"""Source separation with Demucs ``htdemucs``: a vocal stem and an instrumental stem (bass + other,
drums left out so the stem is clean input for note transcription).

Long files are separated in outer blocks (≤ ~3 min plus a few seconds of context on both sides,
joined with a 2 s linear crossfade), so memory stays bounded and progress / cancellation are
reported per Demucs segment.
"""
from __future__ import annotations

import logging
import math
from typing import Callable

import numpy as np

from . import runtime
from .audio import SR

log = logging.getLogger("chords.vocals")

MODEL = "htdemucs"
BLOCK_S = 120.0
FADE_S = 2.0
CONTEXT_S = 3.0
OVERLAP = 0.25

BlockSink = Callable[[int, np.ndarray, np.ndarray], None]  # (sample offset, vocals (2,n), instruments (2,n))
FractionFn = Callable[[float], None]


def load_model(dev: str):
    """The pretrained bag of models on ``dev`` (downloaded into the Hugging Face cache on first use)."""

    def loader():
        from demucs.pretrained import get_model

        model = get_model(MODEL)
        model.eval()
        return model.to(dev)

    return runtime.cached_model(f"demucs:{MODEL}", dev, loader)


def _segment_samples(model) -> int:
    seg = getattr(model, "max_allowed_segment", None)
    if seg is None or not math.isfinite(float(seg)):
        seg = getattr(model.models[0], "segment", 7.8) if hasattr(model, "models") else getattr(model, "segment", 7.8)
    return int(model.samplerate * float(seg))


def plan_blocks(n: int, sr: int = SR, block_s: float | None = None) -> list[tuple[int, int]]:
    """Split ``[0, n)`` into nearly equal blocks of about ``block_s`` (default ``BLOCK_S``) seconds, never
    shorter than ``block_s / 2``."""
    block_s = BLOCK_S if block_s is None else block_s
    count = max(1, int(round(n / (block_s * sr))))
    size = math.ceil(n / count)
    return [(i * size, min(n, (i + 1) * size)) for i in range(count) if i * size < n]


def separate(x: np.ndarray, sink: BlockSink, progress: FractionFn, dev: str) -> None:
    """Separate stereo float32 ``x`` (2, n) at 44.1 kHz; ``sink`` receives consecutive output blocks.

    ``progress(fraction)`` is called after every Demucs segment; an exception raised by it aborts the
    separation and propagates unchanged.
    """
    import torch
    from demucs.apply import apply_model

    n = x.shape[1]
    ref = x.mean(axis=0)
    mu, sd = float(ref.mean()), float(ref.std())
    if n == 0 or sd < 1e-5:  # digital silence: nothing to separate
        zeros = np.zeros_like(x)
        sink(0, zeros, zeros)
        progress(1.0)
        return

    model = load_model(dev)
    sources = list(model.sources)
    i_voc, i_bass, i_other = sources.index("vocals"), sources.index("bass"), sources.index("other")
    seg = _segment_samples(model)
    stride = max(1, int((1 - OVERLAP) * seg))
    fade = int(FADE_S * SR)
    context = int(CONTEXT_S * SR)
    blocks = plan_blocks(n)
    regions = []
    for i, (lo, hi) in enumerate(blocks):
        out_lo = lo - fade // 2 if i > 0 else 0
        out_hi = hi + (fade - fade // 2) if i < len(blocks) - 1 else n
        in_lo, in_hi = max(0, out_lo - context), min(n, out_hi + context)
        regions.append((out_lo, out_hi, in_lo, in_hi))
    total_work = sum(math.ceil((r[3] - r[2]) / stride) for r in regions)
    done = 0
    tail: np.ndarray | None = None
    ramp_in = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    ramp_out = ramp_in[::-1].copy()

    def on_segment(d: dict) -> None:
        nonlocal done
        if d.get("state") == "end":
            done += 1
            progress(min(1.0, done / total_work))

    for i, (out_lo, out_hi, in_lo, in_hi) in enumerate(regions):
        chunk = torch.from_numpy((x[:, in_lo:in_hi] - mu) / sd)
        with torch.inference_mode():
            y = apply_model(model, chunk[None], device=dev, shifts=0, split=True, overlap=OVERLAP,
                            progress=False, num_workers=0, callback=on_segment)[0]
        y = y.numpy() if y.device.type == "cpu" else y.cpu().numpy()
        y = y[:, :, out_lo - in_lo: out_hi - in_lo] * sd + mu
        stems = np.stack([y[i_voc], y[i_bass] + y[i_other]]).astype(np.float32)  # (2 stems, 2 ch, len)
        del y
        if i > 0:
            stems[..., :fade] *= ramp_in
            stems[..., :fade] += tail
        if i < len(regions) - 1:
            stems[..., -fade:] *= ramp_out
            tail = stems[..., -fade:].copy()
            stems = stems[..., :-fade]
        offset = out_lo
        sink(offset, stems[0], stems[1])
    if dev == "mps":
        torch.mps.empty_cache()
    progress(1.0)
