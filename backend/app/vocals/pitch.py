"""Vocal pitch tracking with the CREPE network (torchcrepe weights) at 16 kHz, hop 10 ms.

The network runs only on frames where the vocal stem has some energy (silence is skipped). The
salience is decoded like the original CREPE: a Viterbi path over the 360 pitch bins (20 cents each)
that prefers small steps (±12 bins per frame) but may jump anywhere at a fixed cost (note leaps
are not smeared into slides, single-frame octave blips are ignored), then the local weighted
average around the path bin gives sub-bin precision. ``periodicity`` is the network's activation
at the decoded bin (CREPE's voicing confidence).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

from . import runtime
from .audio import PITCH_SR

HOP = 160  # 10 ms at 16 kHz
WINDOW = 1024
BINS = 360
CENTS_PER_BIN = 20.0
#: MIDI pitch of bin 0 (CREPE: bin b = 1997.38 + 20 b cents above 10 Hz)
MIDI_BIN0 = 69.0 + 12.0 * np.log2(10.0 / 440.0) + 1997.3794084376191 / 100.0
FMIN, FMAX = 55.0, 1250.0  # Hz: A1 .. D#6

# Viterbi decoding
BAND = 12  # bins per frame reachable with the "continuous" transition
JUMP_COST = 8.0  # nats, jump to any bin
EMISSION_FLOOR = 0.01
LOCAL_AVG = 4  # bins on both sides of the path bin

ACTIVE_DB = -50.0  # frames quieter than (loud level + ACTIVE_DB) are not evaluated


@dataclass
class PitchTrack:
    midi: np.ndarray  # (T,) fractional MIDI, NaN where not evaluated
    periodicity: np.ndarray  # (T,) 0..1
    hop: float = HOP / PITCH_SR


def midi_to_bin(midi: float) -> float:
    return (midi - MIDI_BIN0) / (CENTS_PER_BIN / 100.0)


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * np.log2(hz / 440.0)


def n_frames(n_samples: int) -> int:
    return 1 + n_samples // HOP


def capacity_default() -> str:
    raw = os.environ.get("CHORDS_VOCALS_CREPE", "").strip().lower()
    return raw if raw in ("tiny", "full") else "tiny"


def load_model(capacity: str, dev: str):
    def loader():
        import torch
        import torchcrepe

        model = torchcrepe.Crepe(capacity)
        weights = os.path.join(os.path.dirname(torchcrepe.__file__), "assets", f"{capacity}.pth")
        model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True))
        model.eval()
        return model.to(dev)

    return runtime.cached_model(f"crepe:{capacity}", dev, loader)


def frame_rms_db(x16: np.ndarray, win: int = 512) -> np.ndarray:
    """RMS level (dBFS) of ``win``-sample windows centered on the 10 ms frames."""
    t = n_frames(len(x16))
    sq = np.concatenate([[0.0], np.cumsum(x16.astype(np.float64) ** 2)])
    centers = np.arange(t) * HOP
    lo = np.clip(centers - win // 2, 0, len(x16))
    hi = np.clip(centers + win // 2, 0, len(x16))
    energy = (sq[hi] - sq[lo]) / np.maximum(hi - lo, 1)
    return (10.0 * np.log10(energy + 1e-12)).astype(np.float32)


def active_frames(energy_db: np.ndarray) -> np.ndarray:
    loud = float(np.percentile(energy_db, 95)) if len(energy_db) else -120.0
    return energy_db > max(loud + ACTIVE_DB, -75.0)


def salience(x16: np.ndarray, active: np.ndarray, capacity: str, dev: str,
             tick: Optional[Callable[[float], None]] = None, batch: Optional[int] = None) -> np.ndarray:
    """CREPE activations (T, 360) float32; rows of inactive frames stay 0. CPU batches stay small: the
    convolutions' im2col buffers take ~4 MB per frame (1024 frames would need ~7 GB)."""
    import torch

    batch = batch or (128 if dev == "cpu" else 512)
    model = load_model(capacity, dev)
    t = n_frames(len(x16))
    padded = np.pad(x16.astype(np.float32), (WINDOW // 2, WINDOW // 2))
    frames = np.lib.stride_tricks.sliding_window_view(padded, WINDOW)[::HOP][:t]
    out = np.zeros((t, BINS), dtype=np.float32)
    idx = np.flatnonzero(active[:t])
    for k in range(0, len(idx), batch):
        sel = idx[k:k + batch]
        fr = frames[sel].astype(np.float32)
        fr -= fr.mean(axis=1, keepdims=True)
        fr /= np.maximum(fr.std(axis=1, keepdims=True), 1e-10)
        with torch.inference_mode():
            act = model(torch.from_numpy(fr).to(dev))
        out[sel] = act.float().cpu().numpy()
        if tick is not None:
            tick(min(1.0, (k + len(sel)) / max(1, len(idx))))
    return out


def viterbi(logp: np.ndarray, band: int = BAND, jump_cost: float = JUMP_COST) -> np.ndarray:
    """Most likely bin path for log-emissions ``logp`` (T, S): steps up to ``band`` bins cost like
    CREPE's triangular transition, a jump to any bin costs ``jump_cost``."""
    t_len, s = logp.shape
    if t_len == 0:
        return np.zeros(0, dtype=np.int64)
    width = 2 * band + 1
    tri = np.maximum(band + 1 - np.abs(np.arange(-band, band + 1)), 0).astype(np.float64)
    step_cost = np.log(tri / tri.max())  # 0 for no change .. log(1/(band+1)) at the band edge
    states = np.arange(s)
    back = np.empty((t_len, s), dtype=np.int32)
    v = logp[0].astype(np.float64).copy()
    padded = np.full(s + 2 * band, -np.inf)
    for t in range(1, t_len):
        padded[band:band + s] = v
        win = np.lib.stride_tricks.sliding_window_view(padded, width)  # win[j, k] = v[j - band + k]
        cand = win + step_cost
        k = cand.argmax(axis=1)
        local = cand[states, k]
        g = int(v.argmax())
        jump = v[g] - jump_cost
        use_jump = jump > local
        back[t] = np.where(use_jump, g, states - band + k)
        v = np.where(use_jump, jump, local) + logp[t]
    path = np.empty(t_len, dtype=np.int64)
    path[-1] = int(v.argmax())
    for t in range(t_len - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def decode(act: np.ndarray, active: np.ndarray) -> PitchTrack:
    """Viterbi + local average over each run of evaluated frames."""
    t = act.shape[0]
    midi = np.full(t, np.nan, dtype=np.float64)
    per = np.zeros(t, dtype=np.float64)
    lo = int(np.floor(midi_to_bin(hz_to_midi(FMIN))))
    hi = int(np.ceil(midi_to_bin(hz_to_midi(FMAX)))) + 1
    sub = act[:, lo:hi].astype(np.float64)
    edges = np.flatnonzero(np.diff(np.r_[0, active[:t].astype(np.int8), 0]))
    for a, b in zip(edges[::2], edges[1::2]):
        path = viterbi(np.log(sub[a:b] + EMISSION_FLOOR))
        rows = np.arange(a, b)
        offs = np.arange(-LOCAL_AVG, LOCAL_AVG + 1)
        cols = np.clip(path[:, None] + offs[None, :], 0, sub.shape[1] - 1)
        w = sub[rows[:, None], cols]
        wsum = w.sum(axis=1)
        center = np.where(wsum > 1e-9, (w * cols).sum(axis=1) / np.maximum(wsum, 1e-12), path)
        midi[a:b] = MIDI_BIN0 + (center + lo) * (CENTS_PER_BIN / 100.0)
        per[a:b] = sub[rows, path]
    return PitchTrack(midi=midi, periodicity=per)


def track(x16: np.ndarray, energy_db: np.ndarray, capacity: str, dev: str,
          tick: Optional[Callable[[float], None]] = None) -> PitchTrack:
    active = active_frames(energy_db)
    act = salience(x16, active, capacity, dev, tick)
    return decode(act, active)
