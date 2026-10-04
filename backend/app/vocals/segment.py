"""Sung notes from a pitch track (numpy/scipy only; no torch).

Input: frames on a fixed hop (10 ms): raw f0 as fractional MIDI (NaN = not evaluated), CREPE
periodicity (0..1), the vocal stem's energy (dBFS) and optionally an onset-strength curve.

1. voicing = periodicity AND energy (relative to the vocal's loud level), each gated with
   hysteresis (runs above the low threshold that reach the high one);
2. the f0 is median-smoothed inside voiced runs;
3. the singer's global tuning offset = weighted circular mean of the deviation from the semitone
   grid of the pitch averaged over one vibrato period, on frames where it holds still;
4. Viterbi over {silence, semitones} with a strong self-transition preference and a robust
   (outlier-floored) Gaussian emission, so vibrato (±50 cents), scoops and slides don't split notes;
5. repeated notes of the same pitch are split at re-articulations (a consonant / new syllable): at
   the bottom of an energy dip where CREPE's periodicity dips too, scored by the onset-strength
   (spectral flux) peak right after it plus the dip depth;
6. notes shorter than ``min_note`` are absorbed by adjacent notes (or dropped when isolated), as are
   passing notes inside slides and octave blips of the tracker; gaps under ``merge_gap`` between
   notes of the same pitch are closed unless they are articulated; reverb tails are trimmed;
7. per-note pitch = rounded median of the tuning-corrected pitch; velocity from the note's RMS.

The parameters were tuned on the synthetic set of scripts/eval_vocals.py (plateaus, not peaks).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.ndimage import median_filter

SEG_VERSION = 1
MIDI_MIN, MIDI_MAX = 21, 108


@dataclass(frozen=True)
class SegParams:
    hop: float = 0.01
    # voicing: hysteresis on periodicity and on energy relative to the loud level (95th percentile)
    periodicity_on: float = 0.5
    periodicity_off: float = 0.2
    energy_on_db: float = -30.0
    energy_off_db: float = -35.0
    energy_floor_db: float = -65.0  # absolute dBFS
    # pitch model
    median_frames: int = 5
    sigma: float = 0.4  # semitones
    outlier_logp: float = -5.0  # emission floor of a voiced frame (octave blips, fast glides)
    switch_cost: float = 8.0  # nats for a change of note
    interval_cost: float = 0.1  # extra nats per semitone of the change
    off_state_cost: float = 8.0  # voiced frame in silence / unvoiced frame inside a note
    enter_cost: float = 1.0  # silence <-> note
    # repeated notes (re-articulation): score = ln(onset peak / median onset inside notes) + dip / dip_scale
    split_score: float = 2.4
    dip_scale: float = 5.0  # dB of energy dip worth one unit (e) of onset ratio
    dip_context: float = 0.12  # s on both sides of the dip for its depth
    onset_after: float = 0.08  # s after the dip searched for the onset peak (the new syllable)
    per_drop: float = 0.08  # and CREPE's periodicity must dip this much below the note's median
    min_dip_db: float = 1.0  # energy dip required in any case
    dip_db: float = 6.0  # without an onset curve: the energy dip alone
    # notes
    min_note: float = 0.08
    passing_note: float = 0.12  # shorter notes between two contiguous neighbours (inside a slide) are absorbed
    octave_blip: float = 0.25  # shorter notes an octave away from a contiguous, longer neighbour are merged into it
    merge_gap: float = 0.05
    tail_db: float = 15.0  # end a note where its energy stays this far below the note's peak (reverb tails)
    adjacent_gap: float = 0.02
    edge_trim: float = 0.03  # s ignored at both ends of a note (>= 4 trims long) for its pitch
    time_shift: float = 0.0  # s added to note times (measured bias)
    # tuning
    tuning_window: float = 0.19  # s: averaging over ~one vibrato period (5-6 Hz)
    stable_slope: float = 0.03  # semitones per frame of the averaged pitch
    min_tuning_frames: int = 30
    min_tuning_strength: float = 0.15
    # drawing contour
    contour_step: int = 2  # frames (2 x 10 ms = 50 Hz)


DEFAULT = SegParams()


@dataclass
class Note:
    a: int  # first frame
    b: int  # one past the last frame
    pitch: int
    split: bool = False  # starts at a detected re-articulation of the previous note


@dataclass
class Segmentation:
    notes: list[tuple[float, float, int, float]]
    tuning_cents: float
    voiced: np.ndarray
    smooth_midi: np.ndarray  # median-smoothed raw f0 (NaN where unvoiced)
    states: np.ndarray  # Viterbi state per frame (0 = silence, else MIDI)
    params: SegParams = field(default_factory=SegParams)

    def contour(self) -> Optional[dict]:
        p = self.params
        step = max(1, p.contour_step)
        vals = self.smooth_midi[::step]
        ok = np.flatnonzero(np.isfinite(vals))
        if len(ok) == 0:
            return None
        lo, hi = int(ok[0]), int(ok[-1]) + 1
        midi = [round(float(v), 2) if np.isfinite(v) else None for v in vals[lo:hi]]
        return {"start": round(lo * step * p.hop, 3), "hop": round(step * p.hop, 4), "midi": midi}

    def range(self) -> Optional[dict]:
        if not self.notes:
            return None
        pitches = [n[2] for n in self.notes]
        return {"low": int(min(pitches)), "high": int(max(pitches))}


# --------------------------------------------------------------------------- helpers


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of the True runs of a boolean array."""
    edges = np.flatnonzero(np.diff(np.r_[0, np.asarray(mask, dtype=np.int8), 0]))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))


def hysteresis(x: np.ndarray, low: float, high: float) -> np.ndarray:
    """True on runs where ``x >= low`` that reach ``x >= high`` somewhere."""
    x = np.nan_to_num(np.asarray(x, dtype=np.float64), nan=-np.inf)
    out = np.zeros(len(x), dtype=bool)
    for a, b in runs(x >= low):
        if x[a:b].max() >= high:
            out[a:b] = True
    return out


def smooth_in_runs(x: np.ndarray, mask: np.ndarray, size: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    for a, b in runs(mask):
        seg = x[a:b]
        out[a:b] = median_filter(seg, size=min(size, b - a) | 1, mode="nearest") if b - a >= 3 else seg
    return out


def _average_in_runs(x: np.ndarray, mask: np.ndarray, size: int) -> np.ndarray:
    """Centered moving average inside runs of ``mask`` (NaN where the full window doesn't fit)."""
    out = np.full(len(x), np.nan)
    for a, b in runs(mask):
        if b - a >= size:
            avg = np.convolve(x[a:b], np.ones(size) / size, mode="valid")
            out[a + size // 2:a + size // 2 + len(avg)] = avg
    return out


def estimate_tuning(midi: np.ndarray, voiced: np.ndarray, weight: np.ndarray, p: SegParams = DEFAULT) -> float:
    """Global tuning offset in cents (-50..50): the weighted circular mean of the deviation from the
    nearest semitone of the pitch averaged over one vibrato period (so ±50-cent vibrato cancels out
    instead of wrapping around), on frames where that average holds still (sustained notes)."""
    size = max(3, int(round(p.tuning_window / p.hop)) | 1)
    centered = _average_in_runs(midi, voiced & np.isfinite(midi), size)
    slope = np.full(len(midi), np.inf)
    if len(midi) >= 5:
        slope[2:-2] = np.abs(centered[4:] - centered[:-4]) / 4.0
    stable = np.isfinite(centered) & (np.nan_to_num(slope, nan=np.inf) < p.stable_slope)
    if stable.sum() < p.min_tuning_frames:
        return 0.0
    m, w = centered[stable], np.maximum(weight[stable], 1e-3)
    z = np.sum(w * np.exp(2j * np.pi * (m - np.round(m))))
    strength = abs(z) / w.sum()
    if strength < p.min_tuning_strength:
        return 0.0
    cents = float(np.angle(z) / (2 * np.pi) * 100.0)
    return float(np.clip(cents, -50.0, 49.9))


def note_viterbi(x: np.ndarray, voiced: np.ndarray, p: SegParams = DEFAULT) -> np.ndarray:
    """Viterbi over {0 = silence} ∪ semitones: returns the state per frame (0 or the MIDI number)."""
    t_len = len(x)
    states_out = np.zeros(t_len, dtype=np.int64)
    vals = x[voiced & np.isfinite(x)]
    if t_len == 0 or len(vals) == 0:
        return states_out
    lo = int(max(MIDI_MIN, np.floor(np.percentile(vals, 0.5)) - 2))
    hi = int(min(MIDI_MAX, np.ceil(np.percentile(vals, 99.5)) + 2))
    pitches = np.arange(lo, hi + 1, dtype=np.float64)
    k = len(pitches)
    s = k + 1
    xs = np.where(voiced, x, np.nan)
    with np.errstate(invalid="ignore"):
        gauss = -0.5 * ((xs[:, None] - pitches[None, :]) / p.sigma) ** 2
        note_lp = np.logaddexp(gauss, p.outlier_logp)
    emit = np.empty((t_len, s))
    emit[:, 1:] = np.where(voiced[:, None], np.nan_to_num(note_lp, nan=p.outlier_logp), -p.off_state_cost)
    emit[:, 0] = np.where(voiced, -p.off_state_cost, 0.0)
    trans = np.zeros((s, s))
    trans[1:, 1:] = -(p.switch_cost + p.interval_cost * np.abs(pitches[:, None] - pitches[None, :]))
    np.fill_diagonal(trans, 0.0)
    trans[1:, 0] = -p.enter_cost
    trans[0, 1:] = -p.enter_cost
    back = np.empty((t_len, s), dtype=np.int32)
    v = emit[0] + np.r_[0.0, np.full(k, -p.enter_cost)]
    for t in range(1, t_len):
        m = v[:, None] + trans
        arg = m.argmax(axis=0)
        back[t] = arg
        v = m[arg, np.arange(s)] + emit[t]
    path = np.empty(t_len, dtype=np.int64)
    path[-1] = int(v.argmax())
    for t in range(t_len - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return np.where(path > 0, lo + path - 1, 0)


def _dip_depth(e: np.ndarray, t: int, lo: int, hi: int, ctx: int) -> float:
    """How far the energy at frame ``t`` lies below the level before and after it (within [lo, hi))."""
    before = e[max(lo, t - ctx):t]
    after = e[t + 1:min(hi, t + ctx + 1)]
    if len(before) == 0 or len(after) == 0:
        return 0.0
    return float(min(before.max(), after.max()) - e[t])


class _Articulation:
    """Scores re-articulations (a consonant / new syllable on the same pitch) at the bottom of an energy
    dip: ``ln(onset peak right after the dip / median onset strength inside notes) + depth / dip_scale``."""

    def __init__(self, e: np.ndarray, onset: Optional[np.ndarray], per: np.ndarray, voiced: np.ndarray,
                 p: SegParams) -> None:
        self.e, self.p, self.per = e, p, per
        self.onset = onset
        inside = onset[voiced] if onset is not None else np.zeros(0)
        self.ref = float(np.median(inside)) if len(inside) else 0.0
        self.ctx = max(2, int(round(p.dip_context / p.hop)))
        self.after = max(2, int(round(p.onset_after / p.hop)))
        self.min_len = max(1, int(round(p.min_note / p.hop)))

    @property
    def has_onsets(self) -> bool:
        return self.onset is not None and self.ref > 0

    def score(self, m: int, lo: int, hi: int) -> float:
        """Score of a split at frame ``m`` (the bottom of a dip), looking only inside [lo, hi);
        -inf unless the periodicity dips there too (consonants disturb the pitch tracker)."""
        level = float(np.median(self.per[lo:hi])) if hi > lo else 0.0
        if level - float(self.per[max(lo, m - 3):min(hi, m + 4)].min(initial=level)) < self.p.per_drop:
            return -np.inf
        depth = max(0.0, _dip_depth(self.e, m, lo, hi, self.ctx))
        if depth < self.p.min_dip_db:
            return -np.inf
        if not self.has_onsets:
            return depth / self.p.dip_db * self.p.split_score
        # the new syllable's onset must lie inside this note, not at its end (that is the next note's)
        stop = min(hi - self.min_len // 2, m + self.after + 1)
        peak = float(self.onset[max(lo, m - 2):stop].max(initial=0.0))
        if peak <= 0:
            return -np.inf
        return float(np.log(peak / self.ref) + depth / self.p.dip_scale)

    def best(self, a: int, b: int, lo: int, hi: int) -> float:
        """Best score over the frames [a, b) (e.g. a gap between two notes)."""
        a, b = max(a, lo), min(b, hi)
        if b <= a:
            return -np.inf
        m = a + int(np.argmin(self.e[a:b]))
        return self.score(m, lo, hi)


def split_points(art: _Articulation, a: int, b: int, p: SegParams) -> list[int]:
    """Frames inside the note [a, b) where a repeated note of the same pitch starts: local minima of
    the energy whose articulation score reaches ``split_score``, at least ``min_note`` apart."""
    min_len = max(1, int(round(p.min_note / p.hop)))
    e = art.e
    cands: list[tuple[float, int]] = []
    for t in range(a + min_len, b - min_len + 1):
        if e[t] <= e[t - 1] and e[t] < e[t + 1]:
            score = art.score(t, a, b)
            if score >= p.split_score:
                cands.append((score, t))
    chosen: list[int] = []
    for _, t in sorted(cands, reverse=True):  # strongest first
        if all(abs(t - c) >= min_len for c in chosen):
            chosen.append(t)
    return sorted(chosen)


def _absorb_short(notes: list[Note], min_len: int, adj: int, passing: int = 0, octave: int = 0) -> list[Note]:
    """Absorb notes shorter than ``min_len`` into contiguous neighbours (or drop isolated ones), plus
    slightly longer ones (shorter than ``passing``) that are passing notes of a slide (pitch strictly
    between both contiguous neighbours) or a moment's drift off a sustained pitch (both neighbours
    on the same pitch, at most 2 semitones away), and octave blips of the pitch tracker (an octave
    away from a contiguous longer neighbour, shorter than ``octave``)."""
    notes = sorted(notes, key=lambda n: n.a)

    def neighbours(i: int) -> tuple[Optional[Note], Optional[Note]]:
        n = notes[i]
        prev = notes[i - 1] if i > 0 and n.a - notes[i - 1].b <= adj else None
        nxt = notes[i + 1] if i + 1 < len(notes) and notes[i + 1].a - n.b <= adj else None
        return prev, nxt

    def removable(i: int) -> bool:
        n = notes[i]
        dur = n.b - n.a
        if dur < min_len:
            return True
        prev, nxt = neighbours(i)
        if dur < passing and prev is not None and nxt is not None and not n.split:
            if min(prev.pitch, nxt.pitch) < n.pitch < max(prev.pitch, nxt.pitch):
                return True  # passing note of a slide
            if prev.pitch == nxt.pitch and abs(n.pitch - prev.pitch) <= 2:
                return True  # the pitch drifted off a sustained note for a moment
        if dur < octave:
            for o in (prev, nxt):
                if o is not None and o.b - o.a > dur and abs(o.pitch - n.pitch) in (12, 24):
                    return True
        return False

    while True:
        short = [i for i in range(len(notes)) if removable(i)]
        if not short:
            return notes
        i = min(short, key=lambda j: (notes[j].b - notes[j].a, j))
        n = notes[i]
        prev, nxt = neighbours(i)
        if prev is not None and nxt is not None:
            if n.b - n.a >= min_len and abs(prev.pitch - n.pitch) % 12 == 0 and prev.pitch != n.pitch:
                prev.b = n.b  # octave blip at the end of the previous note
            elif n.b - n.a >= min_len and abs(nxt.pitch - n.pitch) % 12 == 0 and nxt.pitch != n.pitch:
                nxt.a = n.a
                nxt.split = nxt.split or n.split
            else:
                mid = (n.a + n.b) // 2
                prev.b, nxt.a = mid, mid
                nxt.split = nxt.split or n.split
        elif prev is not None:
            prev.b = n.b
        elif nxt is not None:
            nxt.a = n.a
            nxt.split = nxt.split or n.split
        del notes[i]


def _note_pitch(mc: np.ndarray, voiced: np.ndarray, n: Note, p: SegParams) -> Optional[int]:
    trim = int(round(p.edge_trim / p.hop))
    a, b = n.a, n.b
    if b - a >= 4 * trim + 1 and trim > 0:
        a, b = a + trim, b - trim
    seg = mc[a:b][voiced[a:b] & np.isfinite(mc[a:b])]
    if len(seg) == 0:
        seg = mc[n.a:n.b][np.isfinite(mc[n.a:n.b])]
    if len(seg) == 0:
        return None
    return int(np.clip(np.round(np.median(seg)), MIDI_MIN, MIDI_MAX))


def _merge_same_pitch(notes: list[Note], art: _Articulation, max_gap: int, p: SegParams) -> list[Note]:
    """Join consecutive notes of the same pitch separated by fewer than ``max_gap`` frames, unless the
    later one starts with a detected re-articulation (or the gap looks like one)."""
    out: list[Note] = []
    for n in notes:
        if out and out[-1].pitch == n.pitch and not n.split and n.a - out[-1].b < max_gap:
            prev = out[-1]
            if n.a > prev.b and art.best(prev.b - 1, n.a + 1, prev.a, n.b) >= p.split_score:
                out.append(n)  # the gap is a consonant / new syllable: keep both notes
                continue
            prev.b = n.b
            continue
        out.append(n)
    return out


def _trim_tails(notes: list[Note], energy: np.ndarray, tail_db: float, min_len: int) -> None:
    """End each note at its last frame within ``tail_db`` of the note's peak energy, unless the next
    note follows right away (legato)."""
    for i, n in enumerate(notes):
        nxt = notes[i + 1] if i + 1 < len(notes) else None
        if nxt is not None and nxt.a - n.b <= 1:
            continue
        seg = energy[n.a:n.b]
        last_loud = n.a + int(np.flatnonzero(seg >= seg.max() - tail_db)[-1]) + 1
        n.b = min(n.b, max(last_loud, n.a + min_len))  # never longer, never below min_len


# --------------------------------------------------------------------------- main entry


def segment(midi: np.ndarray, periodicity: np.ndarray, energy_db: np.ndarray, onset: Optional[np.ndarray] = None,
            p: SegParams = DEFAULT) -> Segmentation:
    midi = np.asarray(midi, dtype=np.float64)
    t_len = len(midi)
    per = np.nan_to_num(np.asarray(periodicity, dtype=np.float64)[:t_len], nan=0.0)
    energy = np.asarray(energy_db, dtype=np.float64)[:t_len]
    finite = np.isfinite(midi)

    # 1. voicing
    loud_frames = energy[energy > p.energy_floor_db]
    loud = float(np.percentile(loud_frames, 95)) if len(loud_frames) else 0.0
    per_s = median_filter(per, size=3, mode="nearest") if t_len >= 3 else per
    v_per = hysteresis(per_s, p.periodicity_off, p.periodicity_on)
    v_en = hysteresis(energy - loud, p.energy_off_db, p.energy_on_db) & (energy > p.energy_floor_db)
    voiced = v_per & v_en & finite

    # 2./3. smoothing and tuning
    smooth = smooth_in_runs(midi, voiced, p.median_frames)
    tuning = estimate_tuning(smooth, voiced, per_s, p)
    mc = smooth - tuning / 100.0

    # 4. note states
    states = note_viterbi(mc, voiced, p)
    notes = [Note(a, b, int(states[a])) for a, b in runs(states > 0)]
    # runs of *different* consecutive states must be separate notes
    split_notes: list[Note] = []
    for n in notes:
        start = n.a
        for t in range(n.a + 1, n.b):
            if states[t] != states[t - 1]:
                split_notes.append(Note(start, t, int(states[start])))
                start = t
        split_notes.append(Note(start, n.b, int(states[start])))
    notes = split_notes

    # 5. repeated notes at re-articulations (onset peak + energy dip)
    e = np.convolve(np.pad(energy, 1, mode="edge"), np.ones(3) / 3.0, mode="valid") if t_len >= 3 else energy
    if onset is not None:
        onset = np.nan_to_num(np.asarray(onset, dtype=np.float64)[:t_len], nan=0.0)
        if len(onset) < t_len:
            onset = np.pad(onset, (0, t_len - len(onset)))
    art = _Articulation(e, onset, per_s, voiced, p)
    out: list[Note] = []
    for n in notes:
        cuts = split_points(art, n.a, n.b, p)
        bounds = [n.a, *cuts, n.b]
        for j in range(len(bounds) - 1):
            out.append(Note(bounds[j], bounds[j + 1], n.pitch, split=n.split if j == 0 else True))
    notes = out

    # 6. short notes, small gaps
    min_len = max(1, int(round(p.min_note / p.hop)))
    adj = int(round(p.adjacent_gap / p.hop))
    notes = _absorb_short(notes, min_len, adj, int(round(p.passing_note / p.hop)), int(round(p.octave_blip / p.hop)))
    notes = _merge_same_pitch(notes, art, int(round(p.merge_gap / p.hop)), p)

    # 7. pitch per note, merge what became identical, velocity
    pitched: list[Note] = []
    for n in notes:
        pitch = _note_pitch(mc, voiced, n, p)
        if pitch is not None:
            n.pitch = pitch
            pitched.append(n)
    notes = _merge_same_pitch(pitched, art, 2, p)
    if p.tail_db > 0:
        _trim_tails(notes, energy, p.tail_db, min_len)
    notes = [n for n in notes if n.b - n.a >= min_len]

    rows: list[tuple[float, float, int, float]] = []
    if notes:
        power = 10.0 ** (energy / 10.0)
        level = np.array([10.0 * np.log10(power[n.a:n.b].mean() + 1e-12) for n in notes])
        ref = float(np.percentile(level, 95))
        for n, db in zip(notes, level):
            vel = float(np.clip(0.95 + (db - ref) / 36.0, 0.05, 1.0))
            start = max(0.0, (n.a - 0.5) * p.hop + p.time_shift)
            end = max(start + p.hop, (n.b - 0.5) * p.hop + p.time_shift)
            rows.append((round(start, 3), round(end, 3), int(n.pitch), round(vel, 3)))
    return Segmentation(notes=rows, tuning_cents=round(tuning, 1), voiced=voiced, smooth_midi=smooth,
                        states=states, params=p)
