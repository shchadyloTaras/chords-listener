"""Sequence decoding (Viterbi / forward-backward with frame-dependent change penalties)
and segment utilities shared by both recognition pipelines."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np
from scipy.special import logsumexp


def change_penalties(n_frames: int, fps: float, beats: Sequence[float], off_beat: float, half_beat: float,
                     tolerance: float = 0.075) -> np.ndarray:
    """Per-frame additive log-penalty for *changing* state between frame t-1 and t.

    Changes close to a beat cost nothing, close to an off-beat (eighth) cost ``half_beat``,
    anywhere else ``off_beat``. Without beats every position is free.
    """
    pen = np.zeros(n_frames)
    beats = np.asarray(beats, dtype=np.float64)
    if len(beats) < 2 or n_frames == 0:
        return pen
    t = (np.arange(n_frames) - 0.5) / fps  # boundary time between frames t-1 and t
    mids = (beats[:-1] + beats[1:]) / 2.0
    d_beat = _nearest_dist(t, beats)
    d_half = _nearest_dist(t, mids)
    ibi = float(np.median(np.diff(beats)))
    tol = min(tolerance, 0.3 * ibi)
    # outside the tracked region (before the first / after the last beat) allow changes freely
    outside = (t < beats[0] - ibi) | (t > beats[-1] + ibi)
    pen[:] = off_beat
    pen[d_half <= tol] = half_beat
    pen[d_beat <= tol] = 0.0
    pen[outside] = 0.0
    return pen


def _nearest_dist(t: np.ndarray, grid: np.ndarray) -> np.ndarray:
    if len(grid) == 0:
        return np.full(len(t), np.inf)
    if len(grid) == 1:
        return np.abs(t - grid[0])
    idx = np.clip(np.searchsorted(grid, t), 1, len(grid) - 1)
    return np.minimum(np.abs(t - grid[idx - 1]), np.abs(t - grid[idx]))


def viterbi(unary: np.ndarray, trans: np.ndarray, init: Optional[np.ndarray] = None, final: Optional[np.ndarray] = None,
            change_pen: Optional[np.ndarray] = None) -> np.ndarray:
    """MAP path of a linear-chain model with log potentials.

    ``trans[i, j]``: log potential of i -> j. ``change_pen[t]`` is subtracted from every
    off-diagonal transition into frame t.
    """
    T, K = unary.shape
    if T == 0:
        return np.zeros(0, dtype=np.int64)
    off = 1.0 - np.eye(K)
    score = unary[0] + (init if init is not None else 0.0)
    back = np.empty((T, K), dtype=np.int32)
    back[0] = np.arange(K)
    for t in range(1, T):
        tr = trans if change_pen is None or change_pen[t] == 0 else trans - change_pen[t] * off
        cand = score[:, None] + tr
        back[t] = np.argmax(cand, axis=0)
        score = cand[back[t], np.arange(K)] + unary[t]
    if final is not None:
        score = score + final
    path = np.empty(T, dtype=np.int64)
    path[-1] = int(np.argmax(score))
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def posteriors(unary: np.ndarray, trans: np.ndarray, init: Optional[np.ndarray] = None,
               final: Optional[np.ndarray] = None,
               change_pen: Optional[np.ndarray] = None) -> np.ndarray:
    """Per-frame state marginals (forward-backward in log space)."""
    T, K = unary.shape
    if T == 0:
        return np.zeros((0, K))
    off = 1.0 - np.eye(K)

    def tr_at(t: int) -> np.ndarray:
        return trans if change_pen is None or change_pen[t] == 0 else trans - change_pen[t] * off

    alpha = np.empty((T, K))
    alpha[0] = unary[0] + (init if init is not None else 0.0)
    for t in range(1, T):
        alpha[t] = logsumexp(alpha[t - 1][:, None] + tr_at(t), axis=0) + unary[t]
    beta = np.zeros((T, K))
    if final is not None:
        beta[-1] = final
    for t in range(T - 2, -1, -1):
        beta[t] = logsumexp(tr_at(t + 1) + (unary[t + 1] + beta[t + 1])[None, :], axis=1)
    post = alpha + beta
    post -= logsumexp(post, axis=1, keepdims=True)
    return np.exp(post)


@dataclass
class Segment:
    start: float
    end: float
    state: int  # decoder class (pipeline specific)
    first: int  # first frame index (inclusive)
    last: int  # last frame index (exclusive)
    confidence: float = 0.0
    info: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return self.end - self.start


def path_to_segments(path: np.ndarray, fps: float, duration: float) -> list[Segment]:
    segs: list[Segment] = []
    if len(path) == 0:
        return segs
    change = np.flatnonzero(np.diff(path)) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [len(path)]])
    for s, e in zip(starts, ends):
        t0 = 0.0 if s == 0 else (s - 0.5) / fps
        t1 = duration if e == len(path) else (e - 0.5) / fps
        segs.append(Segment(float(t0), float(min(t1, duration)), int(path[s]), int(s), int(e)))
    return [s for s in segs if s.end > s.start]


def snap_boundaries(segs: list[Segment], beats: Sequence[float], tolerance: float) -> list[Segment]:
    """Move chord boundaries onto the nearest beat (or off-beat) when within ``tolerance``."""
    if len(segs) < 2 or len(beats) < 2:
        return segs
    beats = np.asarray(beats, dtype=np.float64)
    ibi = float(np.median(np.diff(beats)))
    tol = min(tolerance, 0.3 * ibi)
    half = (beats[:-1] + beats[1:]) / 2.0
    for a, b in zip(segs[:-1], segs[1:]):
        t = b.start
        db = beats[np.argmin(np.abs(beats - t))]
        if abs(db - t) <= tol:
            new = db
        else:
            dh = half[np.argmin(np.abs(half - t))] if len(half) else t
            new = dh if abs(dh - t) <= tol * 0.7 else t
        new = float(np.clip(new, a.start, b.end))
        a.end = new
        b.start = new
    return [s for s in segs if s.end - s.start > 1e-6]


def merge_equal(segs: list[Segment], key=lambda s: s.state) -> list[Segment]:
    out: list[Segment] = []
    for s in segs:
        if out and key(out[-1]) == key(s):
            prev = out[-1]
            w0, w1 = prev.duration, s.duration
            prev.confidence = (prev.confidence * w0 + s.confidence * w1) / max(w0 + w1, 1e-9)
            prev.end = s.end
            prev.last = s.last
        else:
            out.append(s)
    return out


def absorb_short(segs: list[Segment], min_dur: float, score_fn) -> list[Segment]:
    """Remove segments shorter than ``min_dur`` by giving their span to the neighbour that
    explains it best (``score_fn(segment, candidate_state) -> float``)."""
    changed = True
    while changed and len(segs) > 1:
        changed = False
        order = sorted(range(len(segs)), key=lambda i: segs[i].duration)
        for i in order:
            s = segs[i]
            if s.duration >= min_dur:
                break
            cands = []
            if i > 0:
                cands.append((score_fn(s, segs[i - 1].state), i - 1))
            if i + 1 < len(segs):
                cands.append((score_fn(s, segs[i + 1].state), i + 1))
            _, j = max(cands)
            n = segs[j]
            if j < i:
                n.end = s.end
                n.last = s.last
            else:
                n.start = s.start
                n.first = s.first
            del segs[i]
            changed = True
            break
    return segs
