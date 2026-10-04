"""Memory-lean bar-pointer DBN for joint beat/downbeat tracking.

Re-implements madmom's ``DBNDownBeatTrackingProcessor`` (Böck, Krebs & Widmer, 2016:
bar-pointer state space, exponential tempo transitions at beat boundaries,
RNN (down)beat observation model, Viterbi decoding, peak correction) with identical
results but without madmom's dense ``frames x states`` uint32 back-pointer matrix
(~2.4 GB for a 4-minute song, ~18 GB for 30 minutes).

Inside a beat the bar-pointer model is deterministic (position p -> p + 1), so the only
decisions are the tempo choices at beat starts. Storing those (frames x beats x tempi,
int16) is enough to back-track the full path.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np
from numba import njit

MIN_BPM = 55.0
MAX_BPM = 215.0
NUM_TEMPI = 60
TRANSITION_LAMBDA = 100.0
OBSERVATION_LAMBDA = 16
THRESHOLD = 0.05


def beat_intervals(min_interval: float, max_interval: float, num_intervals: int) -> np.ndarray:
    """Tempo intervals (frames per beat) exactly as madmom's BeatStateSpace."""
    intervals = np.arange(np.round(min_interval), np.round(max_interval) + 1)
    if num_intervals is not None and num_intervals < len(intervals):
        num_log = num_intervals
        intervals = []
        while len(intervals) < num_intervals:
            intervals = np.unique(np.round(np.logspace(np.log2(min_interval), np.log2(max_interval), num_log, base=2)))
            num_log += 1
    return np.ascontiguousarray(intervals, dtype=np.int64)


def tempo_transitions(intervals: np.ndarray, transition_lambda: float) -> np.ndarray:
    """log P(tempo j at next beat | tempo i), madmom's exponential_transition."""
    ratio = intervals.astype(float)[None, :] / intervals.astype(float)[:, None]
    prob = np.exp(-transition_lambda * np.abs(ratio - 1.0))
    prob[prob <= np.spacing(1)] = 0
    prob /= prob.sum(axis=1, keepdims=True)
    with np.errstate(divide="ignore"):
        return np.log(prob)


@njit(cache=True, nogil=True)
def _viterbi_bar(log_obs, intervals, log_trans, num_beats, obs_lambda):  # pragma: no cover - compiled
    """Returns (beat index b, tempo index i, position p) per frame and the path log-prob."""
    T = log_obs.shape[0]
    n_int = intervals.shape[0]
    offs = np.zeros(n_int + 1, dtype=np.int64)
    for i in range(n_int):
        offs[i + 1] = offs[i] + intervals[i]
    per_beat = offs[n_int]
    S = per_beat * num_beats
    # observation pointer per state: 0 no beat, 1 beat, 2 downbeat
    ptr = np.zeros(S, dtype=np.int8)
    for b in range(num_beats):
        for i in range(n_int):
            L = intervals[i]
            for p in range(L):
                if p * obs_lambda < L:  # position fraction p/L < 1/obs_lambda
                    ptr[b * per_beat + offs[i] + p] = 2 if b == 0 else 1
    # uniform initial distribution; like madmom, transitions apply from the first frame on
    prev = np.full(S, -np.log(S))
    cur = np.empty(S)
    bp = np.zeros((T, num_beats, n_int), dtype=np.int16)
    for t in range(T):
        o0 = log_obs[t, 0]
        o1 = log_obs[t, 1]
        o2 = log_obs[t, 2]
        for b in range(num_beats):
            base = b * per_beat
            pb = (b - 1 + num_beats) % num_beats
            pbase = pb * per_beat
            for i in range(n_int):
                start = base + offs[i]
                L = intervals[i]
                # beat start: best previous tempo at the end of the previous beat
                best = -np.inf
                arg = 0
                for j in range(n_int):
                    lt = log_trans[j, i]
                    if lt == -np.inf:
                        continue
                    v = prev[pbase + offs[j] + intervals[j] - 1] + lt
                    if v > best:
                        best = v
                        arg = j
                bp[t, b, i] = arg
                pt = ptr[start]
                cur[start] = best + (o2 if pt == 2 else (o1 if pt == 1 else o0))
                for p in range(1, L):
                    s = start + p
                    pt = ptr[s]
                    cur[s] = prev[s - 1] + (o2 if pt == 2 else (o1 if pt == 1 else o0))
        tmp = prev
        prev = cur
        cur = tmp
    # best final state
    best_s = 0
    best_v = prev[0]
    for s in range(1, S):
        if prev[s] > best_v:
            best_v = prev[s]
            best_s = s
    b = best_s // per_beat
    rem = best_s - b * per_beat
    i = 0
    while offs[i + 1] <= rem:
        i += 1
    p = rem - offs[i]
    beats = np.empty(T, dtype=np.int64)
    tempi = np.empty(T, dtype=np.int64)
    pos = np.empty(T, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        beats[t] = b
        tempi[t] = i
        pos[t] = p
        if t == 0:
            break
        if p > 0:
            p -= 1
        else:
            j = bp[t, b, i]
            b = (b - 1 + num_beats) % num_beats
            i = j
            p = intervals[j] - 1
    return beats, tempi, pos, best_v


def track(activations: np.ndarray, fps: float, beats_per_bar: Sequence[int] = (3, 4), min_bpm: float = MIN_BPM,
          max_bpm: float = MAX_BPM, num_tempi: int = NUM_TEMPI, transition_lambda: float = TRANSITION_LAMBDA,
          observation_lambda: int = OBSERVATION_LAMBDA, threshold: float = THRESHOLD) -> Optional[np.ndarray]:
    """Beat/downbeat tracking on (T, 2) [beat, downbeat] activations.

    Returns rows of (time [s], beat number in bar) like madmom, or None.
    """
    act = np.asarray(activations, dtype=np.float64)
    first = 0
    if threshold:
        idx = np.nonzero(act >= threshold)[0]
        if len(idx) == 0:
            return None
        first, last = int(np.min(idx)), int(np.max(idx)) + 1
        act = act[first:last]
    if len(act) < 2 or not act.any():
        return None
    with np.errstate(divide="ignore", invalid="ignore"):
        log_obs = np.empty((len(act), 3))
        log_obs[:, 0] = np.log((1.0 - act.sum(axis=1)) / (observation_lambda - 1))
        log_obs[:, 1] = np.log(act[:, 0])
        log_obs[:, 2] = np.log(act[:, 1])
    log_obs = np.nan_to_num(log_obs, nan=-np.inf)
    intervals = beat_intervals(60.0 * fps / max_bpm, 60.0 * fps / min_bpm, num_tempi)
    log_trans = tempo_transitions(intervals, transition_lambda)
    best = None
    for nb in beats_per_bar:
        b, i, p, logp = _viterbi_bar(log_obs, intervals, log_trans, int(nb), int(observation_lambda))
        if best is None or logp > best[3]:
            best = (b, i, p, logp, int(nb))
    b, i, p, _, nb = best
    L = intervals[i]
    beat_numbers = b + 1
    beat_range = p * observation_lambda < L  # pointer >= 1
    if not beat_range.any():
        return None
    edges = np.nonzero(np.diff(beat_range.astype(int)))[0] + 1
    if beat_range[0]:
        edges = np.r_[0, edges]
    if beat_range[-1]:
        edges = np.r_[edges, beat_range.size]
    peaks = []
    for left, right in edges.reshape((-1, 2)):
        peaks.append(int(np.argmax(act[left:right])) // 2 + left)
    peaks = np.asarray(peaks, dtype=int)
    return np.vstack(((peaks + first) / float(fps), beat_numbers[peaks])).T


def warmup() -> None:
    _viterbi_bar(np.zeros((4, 3)), np.array([2, 3], dtype=np.int64), np.zeros((2, 2)), 2, 16)
