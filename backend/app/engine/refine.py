"""Chord quality and bass (slash) refinement inside decoded segments.

The coarse decoder gives root + maj/min (or N) per segment. Inside each segment we test
richer qualities against two kinds of pitch-class evidence -- the learned deep chroma
(when available) and the NNLS-style DSP chroma -- with priors that strongly favour plain
triads: users are hurt more by a spurious "Cmaj7" than by a missing one.

A segment keeps one quality unless a clearly better explanation splits it once into two
parts of at least ~2 beats (e.g. ``Asus4 -> A``, ``C -> C7``). The bass is decided per
resulting chord from the bass-register chroma; inversions need a dominant, sustained
non-root bass so that alternating root/fifth bass lines never produce slash chords.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .chords import NO_CHORD, QUALITIES, Chord

#: candidate qualities per coarse class
CANDIDATES: dict[str, tuple[str, ...]] = {
    "maj": ("maj", "7", "maj7", "sus4", "sus2", "aug"),
    "min": ("min", "min7", "dim", "sus4", "sus2"),
}

#: first-inversion re-rootings: chord-recognition front ends tend to name an inverted
#: triad after its bass (G/B -> "Bm", D#m/F# -> "F#"). (coarse quality, root shift, quality)
INVERSIONS: dict[str, tuple[tuple[int, str], ...]] = {
    "maj": ((9, "min"),),  # F# coarse -> D#m/F#
    "min": ((8, "maj"),),  # Bm coarse -> G/B
}

#: log-prior (relative to the plain triad) per beat, in units of the per-frame log-likelihood
PRIORS: dict[str, float] = {
    "maj": 0.0, "min": 0.0,
    "7": -1.1, "maj7": -1.45, "min7": -1.1,
    "sus4": -1.8, "sus2": -2.0, "dim": -1.8, "aug": -2.5,
}
INVERSION_PRIOR = -1.8


@dataclass
class RefineParams:
    priors: dict[str, float] = field(default_factory=lambda: dict(PRIORS))
    dc_weight: float = 1.0  # deep chroma evidence weight
    dsp_weight: float = 0.7  # NNLS chroma evidence weight
    split_penalty: float = 3.0  # cost of splitting a segment into two qualities
    min_split_beats: float = 1.8  # each part of a split must last this many beats
    onset_skip: float = 0.12  # s of each chord start ignored (previous chord still ringing)
    slash_ratio: float = 1.8  # bass pitch must beat the root's bass share by this factor
    slash_ratio_fifth: float = 2.6
    min_bass_share: float = 0.34
    min_slash_beats: float = 1.5
    inversions: bool = True  # consider first-inversion re-rootings of the coarse chord
    # deep-chroma veto (melody notes are not chord tones): a candidate that adds a tone to
    # the coarse triad needs this much deep-chroma support for it, and may not drop a tone
    # the deep chroma clearly hears
    veto_add: float = 0.18
    veto_remove: float = 0.55


DEFAULT_PARAMS = RefineParams()


# ----------------------------------------------------------------------------------------
# evidence models


def _templates(root: int, qualities: tuple[str, ...]) -> np.ndarray:
    return _chord_templates([(root, q) for q in qualities])


def _chord_templates(chords: list[tuple[int, str]]) -> np.ndarray:
    M = np.zeros((len(chords), 12))
    for k, (root, q) in enumerate(chords):
        for i in QUALITIES[q][0]:
            M[k, (root + i) % 12] = 1.0
    return M


def bernoulli_scores(prob: np.ndarray, M: np.ndarray) -> np.ndarray:
    """Per-frame log-likelihood of each template row under per-bin presence probabilities.
    prob: (T, 12); M: (K, 12) binary -> (T, K)."""
    p = np.clip(prob, 0.03, 0.97)
    return np.log(p) @ M.T + np.log(1 - p) @ (1 - M).T


def bernoulli_ll(prob: np.ndarray, root: int, quality: str) -> float:
    """Mean per-frame log-likelihood of one chord (convenience wrapper)."""
    return float(bernoulli_scores(np.atleast_2d(prob), _templates(root, (quality,)))[:, 0].mean())


def deep_chroma_probabilities(dc: np.ndarray) -> np.ndarray:
    """Calibrate deep-chroma outputs: chord tones that the network only half-believes
    (e.g. major sevenths, ~0.25) are still far above absent tones (~0.02)."""
    return np.sqrt(np.clip(dc, 0.0, 1.0))


def chroma_probabilities(chroma: np.ndarray) -> np.ndarray:
    """Map non-negative (NNLS) chroma frames to soft 'pitch class is sounding' probabilities."""
    c = np.asarray(chroma, dtype=np.float64)
    top = np.max(c, axis=-1, keepdims=True)
    # adaptive noise floor: dense mixes (vocals, distortion, drums) lift every bin, so
    # only energy above the frame's median counts as evidence for a pitch class
    floor = np.median(c, axis=-1, keepdims=True)
    rel = np.clip((c - floor) / np.maximum(top - floor, 1e-9), 0.0, 1.0)
    p = 1.0 / (1.0 + np.exp(-(rel - 0.22) * 12.0))
    # frames without harmonic content carry no evidence
    return np.where(top > 1e-6, p, 0.5)


# ----------------------------------------------------------------------------------------
# refinement


@dataclass
class Evidence:
    """Frame-wise features with their frame times."""

    dc: Optional[np.ndarray]  # (T1, 12) deep chroma (or None)
    dc_times: Optional[np.ndarray]
    treble: np.ndarray  # (T2, 12) NNLS treble chroma
    bass: np.ndarray  # (T2, 12) NNLS bass chroma
    times: np.ndarray

    def __post_init__(self):
        self.dc_prob = deep_chroma_probabilities(self.dc) if self.dc is not None else None
        self.dsp_prob = chroma_probabilities(self.treble)


def _idx(times: np.ndarray, a: float, b: float) -> np.ndarray:
    idx = np.flatnonzero((times >= a) & (times < b))
    if len(idx) == 0 and len(times):
        idx = np.array([int(np.clip(np.searchsorted(times, (a + b) / 2), 0, len(times) - 1))])
    return idx


def _units(start: float, end: float, beats: np.ndarray) -> list[tuple[float, float]]:
    """Split [start, end) at beats (or every 0.5 s when there are no beats)."""
    inner = beats[(beats > start + 0.05) & (beats < end - 0.05)] if len(beats) else np.zeros(0)
    if len(inner) == 0 and len(beats) < 2 and end - start > 1.0:
        inner = np.arange(start + 0.5, end - 0.25, 0.5)
    edges = [start, *inner.tolist(), end]
    return [(a, b) for a, b in zip(edges[:-1], edges[1:]) if b > a]


def _unit_scores(ev: Evidence, units, seg_start: float, cands: list[tuple[int, str]],
                 params: RefineParams) -> np.ndarray:
    """(U, K) evidence per unit and candidate chord (root, quality)."""
    M = _chord_templates(cands)
    E = np.zeros((len(units), len(cands)))
    for u, (a, b) in enumerate(units):
        a_eff = max(a, seg_start + params.onset_skip) if u == 0 else a
        if a_eff >= b:
            a_eff = a
        s = np.zeros(len(cands))
        if ev.dc_prob is not None and params.dc_weight > 0:
            s += params.dc_weight * bernoulli_scores(ev.dc_prob[_idx(ev.dc_times, a_eff, b)], M).mean(axis=0)
        if params.dsp_weight > 0:
            s += params.dsp_weight * bernoulli_scores(ev.dsp_prob[_idx(ev.times, a_eff, b)], M).mean(axis=0)
        E[u] = s
    return E


def _best_quality(E: np.ndarray, w: np.ndarray, prior: np.ndarray) -> tuple[int, float]:
    tot = (E + prior[None, :]) * w[:, None]
    s = tot.sum(axis=0)
    k = int(np.argmax(s))
    return k, float(s[k])


def refine_segment(ev: Evidence, start: float, end: float, coarse: Chord, beats: np.ndarray, ibi: float,
                   params: RefineParams = DEFAULT_PARAMS, candidates: Optional[tuple[str, ...]] = None
                   ) -> list[tuple[float, float, Chord]]:
    """Refine one coarse segment into 1-2 chords with qualities and basses."""
    if coarse.is_none:
        return [(start, end, NO_CHORD)]
    r0 = coarse.root
    # candidates: (root, quality, inverted-over-the-coarse-root)
    qualities = candidates or CANDIDATES.get(coarse.quality, (coarse.quality,))
    cands: list[tuple[int, str, bool]] = [(r0, q, False) for q in qualities]
    prior_l = [params.priors.get(q, -2.0) for _, q, _ in cands]
    if candidates is None and params.inversions:
        share = _bass_share(ev, start, end)
        for shift, q in INVERSIONS.get(coarse.quality, ()):
            # only when the bass really sits on the coarse root
            if share is not None and int(np.argmax(share)) == r0:
                cands.append(((r0 + shift) % 12, q, True))
                prior_l.append(params.priors.get(q, 0.0) + INVERSION_PRIOR)
    units = _units(start, end, beats)
    w = np.array([(b - a) / ibi for a, b in units])
    prior = np.array(prior_l)
    E = _unit_scores(ev, units, start, [(r, q) for r, q, _ in cands], params)
    if ev.dc is not None and len(cands) > 1:
        prior = prior + _veto(ev, start, end, coarse, cands, params)
    k_all, s_all = _best_quality(E, w, prior)
    parts = [(0, len(units), k_all)]
    best_gain = 0.0
    cum = np.cumsum(w)
    for cut in range(1, len(units)):
        if cum[cut - 1] < params.min_split_beats or cum[-1] - cum[cut - 1] < params.min_split_beats:
            continue
        kl, sl = _best_quality(E[:cut], w[:cut], prior)
        kr, sr = _best_quality(E[cut:], w[cut:], prior)
        if kl == kr:
            continue
        gain = sl + sr - s_all - params.split_penalty
        if gain > best_gain:
            best_gain = gain
            parts = [(0, cut, kl), (cut, len(units), kr)]
    out = []
    for i0, i1, k in parts:
        a, b = units[i0][0], units[i1 - 1][1]
        root, quality, inverted = cands[k]
        if inverted:
            bass = r0
        else:
            if quality == "aug":  # symmetric chord: name it after the bass
                root = _aug_root(ev, a, b, root)
            bass = detect_bass(ev, a, b, root, quality, (b - a) / ibi, params)
        out.append((a, b, Chord(root, quality, bass)))
    return out


def _veto(ev: Evidence, start: float, end: float, coarse: Chord, cands: list[tuple[int, str, bool]],
          params: RefineParams) -> np.ndarray:
    """-inf for candidates whose added / removed tones contradict the deep chroma."""
    dc = ev.dc[_idx(ev.dc_times, min(start + params.onset_skip, (start + end) / 2), end)].mean(axis=0)
    base = set(coarse.pitch_classes())
    out = np.zeros(len(cands))
    for k, (root, q, _) in enumerate(cands):
        tones = {(root + i) % 12 for i in QUALITIES[q][0]}
        added, removed = tones - base, base - tones
        if any(dc[t] < params.veto_add for t in added) or any(dc[t] > params.veto_remove for t in removed):
            out[k] = -np.inf
    return out


def _bass_share(ev: Evidence, a: float, b: float) -> Optional[np.ndarray]:
    frames = ev.bass[_idx(ev.times, a, b)]
    if len(frames) == 0:
        return None
    m = frames.mean(axis=0)
    tot = m.sum()
    return m / tot if tot > 1e-9 else None


def _aug_root(ev: Evidence, a: float, b: float, root: int) -> int:
    share = _bass_share(ev, a, b)
    if share is None:
        return root
    opts = [root, (root + 4) % 12, (root + 8) % 12]
    best = max(opts, key=lambda r: share[r])
    return best if share[best] > 1.5 * share[root] else root


def detect_bass(ev: Evidence, a: float, b: float, root: int, quality: str, beats_len: float,
                params: RefineParams = DEFAULT_PARAMS) -> Optional[int]:
    """Bass pitch class if the chord is clearly an inversion / slash chord, else None."""
    if beats_len < params.min_slash_beats:
        return None
    share = _bass_share(ev, a, b)
    if share is None:
        return None
    pc = int(np.argmax(share))
    if pc == root:
        return None
    rel = (pc - root) % 12
    allowed = set(QUALITIES[quality][0][1:])
    if quality in ("maj", "min"):
        allowed.add(10)  # e.g. C/A#, Am/G descending bass lines
    if rel not in allowed:
        return None
    ratio = params.slash_ratio_fifth if rel == 7 else params.slash_ratio
    if share[pc] < params.min_bass_share or share[pc] < ratio * share[root]:
        return None
    return pc
