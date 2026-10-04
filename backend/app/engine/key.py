"""Global key estimation: key-CNN probabilities (when available) + chord-histogram fit +
pitch-class profile correlation."""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

from .chords import PITCH_NAMES, Chord

# Temperley (Kostka-Payne) profiles
_MAJOR_PROFILE = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
_MINOR_PROFILE = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])

# diatonic triads: (interval from tonic, coarse quality) -> weight
_MAJOR_CHORDS = {(0, "maj"): 1.0, (2, "min"): 0.8, (4, "min"): 0.7, (5, "maj"): 1.0, (7, "maj"): 1.0,
                 (9, "min"): 0.9, (11, "dim"): 0.5, (10, "maj"): 0.35, (2, "maj"): 0.3, (4, "maj"): 0.3,
                 (5, "min"): 0.3}
_MINOR_CHORDS = {(0, "min"): 1.0, (2, "dim"): 0.5, (3, "maj"): 0.9, (5, "min"): 0.9, (7, "min"): 0.6,
                 (7, "maj"): 0.9, (8, "maj"): 0.9, (10, "maj"): 0.9, (5, "maj"): 0.3, (2, "min"): 0.3}

_COARSE = {"maj": "maj", "7": "maj", "maj7": "maj", "6": "maj", "9": "maj", "add9": "maj", "aug": "maj",
           "min": "min", "min7": "min", "min6": "min", "dim": "dim", "dim7": "dim", "hdim7": "dim",
           "sus2": "sus", "sus4": "sus"}


def _profile_scores(chroma: np.ndarray) -> np.ndarray:
    scores = np.zeros(24)
    c = chroma - chroma.mean()
    if np.linalg.norm(c) < 1e-9:
        return scores
    for k in range(12):
        for m, prof in enumerate((_MAJOR_PROFILE, _MINOR_PROFILE)):
            p = np.roll(prof, k)
            p = p - p.mean()
            scores[m * 12 + k] = float(np.dot(c, p) / (np.linalg.norm(c) * np.linalg.norm(p)))
    return scores


def _chord_scores(chords: Sequence[tuple[Chord, float]], tonic_weight: float = 0.6, first_bonus: float = 0.3,
                  last_bonus: float = 0.2) -> np.ndarray:
    scores = np.zeros(24)
    total = sum(d for c, d in chords if not c.is_none)
    if total <= 0:
        return scores
    voiced = [(c, d) for c, d in chords if not c.is_none]
    first, last = voiced[0][0], voiced[-1][0]
    for k in range(12):
        for m, table in enumerate((_MAJOR_CHORDS, _MINOR_CHORDS)):
            tonic_q = "maj" if m == 0 else "min"
            fit = 0.0
            tonic_share = 0.0
            for c, d in voiced:
                coarse = _COARSE.get(c.quality, "maj")
                rel = (c.root - k) % 12
                if coarse == "sus":
                    w = max(table.get((rel, "maj"), 0.0), table.get((rel, "min"), 0.0)) * 0.8
                else:
                    w = table.get((rel, coarse), 0.0)
                fit += w * d
                if rel == 0 and coarse == tonic_q:
                    tonic_share += d
            s = fit / total + tonic_weight * tonic_share / total
            for c, bonus in ((first, first_bonus), (last, last_bonus)):
                if (c.root - k) % 12 == 0 and _COARSE.get(c.quality) == tonic_q:
                    s += bonus
            scores[m * 12 + k] = s
    return scores


def key_scores(chords: Sequence[tuple[Chord, float]], chroma_mean: Optional[np.ndarray],
               cnn_probs: Optional[np.ndarray] = None, w_chords: float = 2.5, w_profile: float = 1.0,
               w_cnn: float = 0.1, **chord_kw) -> np.ndarray:
    """Scores of the 24 keys (0..11 major from C, 12..23 minor from C)."""
    s = w_chords * _chord_scores(chords, **chord_kw)
    if chroma_mean is not None:
        s += w_profile * _profile_scores(np.asarray(chroma_mean, dtype=np.float64))
    if cnn_probs is not None:
        s += w_cnn * np.log(np.asarray(cnn_probs) + 1e-3)
    return s


def detect_key(chords: Sequence[tuple[Chord, float]], chroma_mean: Optional[np.ndarray],
               cnn_probs: Optional[np.ndarray] = None) -> dict:
    s = key_scores(chords, chroma_mean, cnn_probs)
    if not np.any(s):
        return {"tonic": "C", "mode": "major", "name": "C", "confidence": 0.0}
    best = int(np.argmax(s))
    p = np.exp((s - s.max()) * 4.0)
    p /= p.sum()
    tonic = PITCH_NAMES[best % 12]
    mode = "major" if best < 12 else "minor"
    return {"tonic": tonic, "mode": mode, "name": tonic + ("" if mode == "major" else "m"),
            "confidence": round(float(p[best]), 3)}
