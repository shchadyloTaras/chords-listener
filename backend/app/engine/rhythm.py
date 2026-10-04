"""Beats, downbeats, tempo and time signature."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np


@dataclass
class Rhythm:
    beats: np.ndarray
    downbeats: np.ndarray
    time_signature: int
    tempo: float
    source: str

    @property
    def ibi(self) -> float:
        return 60.0 / self.tempo if self.tempo > 0 else 0.5


def tempo_from_beats(beats: np.ndarray) -> float:
    if len(beats) < 2:
        return 0.0
    ibi = np.diff(beats)
    ibi = ibi[(ibi > 0.2) & (ibi < 2.0)]
    if len(ibi) == 0:
        return 0.0
    return float(60.0 / np.median(ibi))


def from_dbn(res: np.ndarray) -> Rhythm:
    """``res``: madmom DBNDownBeatTrackingProcessor output, rows of (time, beat_number)."""
    beats = res[:, 0].astype(np.float64)
    numbers = res[:, 1].astype(int)
    downbeats = beats[numbers == 1]
    ts = int(np.max(numbers)) if len(numbers) else 4
    if ts not in (2, 3, 4, 5, 6, 7):
        ts = 4
    return Rhythm(beats=beats, downbeats=downbeats, time_signature=ts, tempo=tempo_from_beats(beats), source="dbn")


def choose_meter(beats: np.ndarray, change_times: Sequence[float], change_weights: Optional[Sequence[float]] = None
                 ) -> tuple[np.ndarray, int]:
    """Pick time signature (4 or 3) and bar phase so that chord changes fall on downbeats."""
    if len(beats) < 4:
        return beats[:1].copy(), 4
    changes = np.asarray(change_times, dtype=np.float64)
    w = np.ones(len(changes)) if change_weights is None else np.asarray(change_weights, dtype=np.float64)
    ibi = float(np.median(np.diff(beats)))
    best = (-1.0, 4, 0)
    results = {}
    for meter in (4, 3):
        for phase in range(meter):
            downs = beats[phase::meter]
            if len(changes) == 0:
                score = 1.0 if phase == 0 else 0.0
            else:
                d = np.min(np.abs(changes[:, None] - downs[None, :]), axis=1)
                hit = d < 0.3 * ibi
                score = float(np.sum(w * hit) / max(np.sum(w), 1e-9))
            results[(meter, phase)] = score
            if meter == 4 and score > best[0]:
                best = (score, meter, phase)
    best4 = best
    best3 = max(((results[(3, p)], 3, p) for p in range(3)), key=lambda r: r[0])
    # 3/4 only when changes clearly follow a 3-beat grid (and are not also on the 4-grid)
    chosen = best3 if (best3[0] > best4[0] + 0.2 and best3[0] > 0.6) else best4
    _, meter, phase = chosen
    return beats[phase::meter].copy(), meter


def librosa_rhythm(y22: np.ndarray) -> Rhythm:
    from .features import track_beats

    beats, tempo = track_beats(y22)
    if len(beats) >= 2:
        tempo = tempo_from_beats(beats) or tempo
    return Rhythm(beats=beats, downbeats=beats[::4].copy(), time_signature=4, tempo=float(tempo), source="librosa")
