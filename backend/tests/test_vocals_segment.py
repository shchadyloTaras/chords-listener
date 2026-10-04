"""Vocal note segmentation (app.vocals.segment) on synthetic frame features: vibrato, slides, scoops,
repeated notes, tuning offsets, silence, short notes, octave blips. Plus the numpy-only parts of the pitch
decoder, the onset curve and the separation block plan. Fast; torch is not needed."""
from __future__ import annotations

import numpy as np
import pytest

from app.vocals import pitch, segment
from app.vocals.features import onset_strength
from app.vocals.separate import plan_blocks

HOP = 0.01


class Frames:
    """Synthetic per-frame features at 100 Hz: raw f0 (fractional MIDI), periodicity, energy, onset."""

    def __init__(self, total: float, seed: int = 0) -> None:
        self.t = np.arange(int(round(total / HOP)) + 1) * HOP
        n = len(self.t)
        self.rng = np.random.default_rng(seed)
        self.midi = np.full(n, np.nan)
        self.per = np.full(n, 0.03)
        self.energy = np.full(n, -85.0)
        self.onset = self.rng.uniform(0.5, 1.5, n)

    def idx(self, time: float) -> int:
        return int(round(time / HOP))

    def note(self, start: float, end: float, midi: float, *, cents: float = 0.0, vibrato: float = 0.0,
             db: float = -20.0, attack: bool = True) -> Frames:
        a, b = self.idx(start), self.idx(end)
        tt = self.t[a:b] - start
        vib = vibrato / 100.0 * np.sin(2 * np.pi * 5.5 * tt) * np.clip(tt / 0.15, 0, 1)
        self.midi[a:b] = midi + cents / 100.0 + vib + self.rng.normal(0, 0.02, b - a)
        self.per[a:b] = 0.88 + self.rng.uniform(-0.03, 0.03, b - a)
        self.energy[a:b] = db + self.rng.normal(0, 0.3, b - a)
        self.onset[a:b] = 5.0 + self.rng.uniform(-1, 1, b - a)
        if attack:
            self.onset[a:a + 3] = 60.0
        return self

    def glide(self, center: float, length: float, frm: float, to: float, cents: float = 0.0) -> Frames:
        a, b = self.idx(center - length / 2), self.idx(center + length / 2)
        self.midi[a:b] = np.linspace(frm, to, b - a) + cents / 100.0
        return self

    def rearticulate(self, at: float, dip_db: float = 10.0) -> Frames:
        """A voiced consonant: energy + periodicity dip centered on ``at``, onset peak just after it."""
        c = self.idx(at)
        w = np.sin(np.linspace(0, np.pi, 7)) ** 2
        self.energy[c - 3:c + 4] -= dip_db * w
        self.per[c - 3:c + 4] -= 0.3 * w
        self.onset[c + 2:c + 5] = 70.0
        return self

    def dropout(self, at: float, frames: int) -> Frames:
        c = self.idx(at)
        self.per[c:c + frames] = 0.05
        self.midi[c:c + frames] = np.nan
        return self

    def run(self, **params) -> segment.Segmentation:
        p = segment.SegParams(**params) if params else segment.DEFAULT
        return segment.segment(self.midi, self.per, self.energy, self.onset, p)


def pitches(seg: segment.Segmentation) -> list[int]:
    return [n[2] for n in seg.notes]


# --------------------------------------------------------------------------- notes


@pytest.mark.parametrize("vibrato", [30.0, 50.0, 60.0])
def test_vibrato_stays_one_note(vibrato: float) -> None:
    seg = Frames(3.0).note(0.5, 2.3, 64, vibrato=vibrato).run()
    assert pitches(seg) == [64]
    start, end, _, vel = seg.notes[0]
    assert abs(start - 0.5) <= 0.03 and abs(end - 2.3) <= 0.03
    assert 0.0 < vel <= 1.0


def test_slide_splits_at_its_middle() -> None:
    f = Frames(2.5).note(0.5, 1.0, 60).note(1.0, 2.0, 65, attack=False)
    f.glide(1.0, 0.07, 60, 65)
    seg = f.run()
    assert pitches(seg) == [60, 65]
    assert abs(seg.notes[1][0] - 1.0) <= 0.04
    assert abs(seg.notes[0][1] - seg.notes[1][0]) <= 0.011  # legato: no gap


def test_scoop_into_a_note_is_not_a_note() -> None:
    f = Frames(2.0).note(0.5, 1.5, 67)
    f.midi[f.idx(0.5):f.idx(0.56)] = np.linspace(65.8, 66.9, f.idx(0.56) - f.idx(0.5))  # 120 cents below
    seg = f.run()
    assert pitches(seg) == [67]
    assert abs(seg.notes[0][0] - 0.5) <= 0.02


def test_portamento_through_passing_semitones_has_no_passing_notes() -> None:
    f = Frames(2.5).note(0.5, 1.0, 60).note(1.0, 2.0, 64, attack=False)
    f.glide(1.0, 0.16, 60, 64)  # a slow slide crosses 61, 62, 63
    seg = f.run()
    assert pitches(seg) == [60, 64]


def test_repeated_notes_split_at_a_rearticulation() -> None:
    f = Frames(2.5).note(0.5, 1.6, 62).rearticulate(1.05)
    seg = f.run()
    assert pitches(seg) == [62, 62]
    assert abs(seg.notes[1][0] - 1.05) <= 0.03
    assert abs(seg.notes[0][1] - 1.05) <= 0.03


def test_repeated_notes_split_at_an_unvoiced_consonant() -> None:
    f = Frames(2.5).note(0.5, 1.0, 62).note(1.06, 1.7, 62)
    f.energy[f.idx(1.0):f.idx(1.06)] = -45.0  # consonant noise: some energy, no pitch
    seg = f.run()
    assert pitches(seg) == [62, 62]
    assert abs(seg.notes[1][0] - 1.06) <= 0.03


def test_tracker_dropout_inside_a_note_is_merged() -> None:
    f = Frames(2.5).note(0.5, 1.8, 59).dropout(1.1, 2)  # 20 ms without pitch, no dip, no onset
    seg = f.run()
    assert pitches(seg) == [59]
    assert abs(seg.notes[0][0] - 0.5) <= 0.02 and abs(seg.notes[0][1] - 1.8) <= 0.03


def test_no_split_without_articulation() -> None:
    f = Frames(3.0).note(0.5, 2.5, 69, vibrato=50)
    tt = f.t[f.idx(0.5):f.idx(2.5)] - 0.5
    f.energy[f.idx(0.5):f.idx(2.5)] += 2.5 * np.sin(2 * np.pi * 5.5 * tt)  # vibrato tremolo
    f.onset[f.idx(0.7):f.idx(2.5):18] = 12.0  # some spectral flux from the vibrato
    seg = f.run()
    assert pitches(seg) == [69]


@pytest.mark.parametrize("cents", [30.0, -40.0, 45.0, -48.0, 0.0])
def test_tuning_offset_is_removed(cents: float) -> None:
    f = Frames(5.0)
    melody = [(0.3, 0.9, 60), (0.9, 1.5, 62), (1.6, 2.2, 64), (2.3, 3.0, 65), (3.1, 3.9, 67), (4.0, 4.7, 64)]
    for start, end, m in melody:
        f.note(start, end, m, cents=cents, vibrato=35)
    seg = f.run()
    assert pitches(seg) == [m for _, _, m in melody]
    assert abs(seg.tuning_cents - cents) <= 6.0


def test_silence_and_unpitched_noise_give_nothing() -> None:
    seg = Frames(3.0).run()
    assert seg.notes == [] and seg.contour() is None and seg.range() is None and seg.tuning_cents == 0.0
    f = Frames(3.0)
    f.energy[:] = -25.0  # loud, but no periodicity (drums / breath in the vocal stem)
    f.per[:] = 0.1
    f.midi[:] = 60 + f.rng.normal(0, 3, len(f.midi))
    assert f.run().notes == []


def test_short_notes() -> None:
    f = Frames(3.0).note(0.5, 0.55, 70)  # isolated 50 ms blip: dropped
    f.note(1.0, 2.2, 62)
    a = f.idx(1.6)
    f.midi[a:a + 5] = 64.0  # a 50 ms excursion inside the long note: absorbed
    seg = f.run()
    assert pitches(seg) == [62]
    assert abs(seg.notes[0][0] - 1.0) <= 0.02 and abs(seg.notes[0][1] - 2.2) <= 0.03


def test_octave_blip_at_a_note_start_is_merged() -> None:
    f = Frames(2.5).note(0.5, 1.8, 57)
    f.midi[f.idx(0.5):f.idx(0.65)] += 12.0  # the tracker locked on the octave for 150 ms
    seg = f.run()
    assert pitches(seg) == [57]
    assert abs(seg.notes[0][0] - 0.5) <= 0.02


def test_real_octave_leap_is_kept() -> None:
    seg = Frames(3.0).note(0.5, 1.2, 55).note(1.3, 2.2, 67).run()
    assert pitches(seg) == [55, 67]


def test_velocity_follows_the_level() -> None:
    seg = Frames(3.0).note(0.5, 1.0, 60, db=-12).note(1.5, 2.0, 60, db=-30).run()
    assert len(seg.notes) == 2
    loud, quiet = seg.notes[0][3], seg.notes[1][3]
    assert 0.0 < quiet < loud <= 1.0


def test_contour_and_range() -> None:
    f = Frames(3.0).note(0.5, 1.0, 60, cents=20).note(1.5, 2.0, 72, cents=20)
    seg = f.run()
    c = seg.contour()
    assert c is not None and c["hop"] == pytest.approx(0.02)
    assert c["start"] == pytest.approx(0.5, abs=0.021)
    voiced = [m for m in c["midi"] if m is not None]
    assert len(c["midi"]) == pytest.approx((2.0 - 0.5) / 0.02, abs=2)
    assert any(m is None for m in c["midi"])  # the gap between the notes
    assert all(abs(m - 60.2) < 0.15 or abs(m - 72.2) < 0.15 for m in voiced)  # raw f0, not tuning-corrected
    assert seg.range() == {"low": 60, "high": 72}
    assert all(isinstance(v, float) for v in voiced)


def test_notes_are_sorted_and_well_formed() -> None:
    f = Frames(6.0, seed=3)
    t = 0.3
    for m in (60, 62, 64, 62, 60, 67, 65, 64):
        f.note(t, t + 0.45, m, vibrato=40)
        t += 0.6
    seg = f.run()
    assert pitches(seg) == [60, 62, 64, 62, 60, 67, 65, 64]
    for (s0, e0, m0, v0), nxt in zip(seg.notes, seg.notes[1:] + [None]):
        assert 0 <= s0 < e0 and 21 <= m0 <= 108 and 0 <= v0 <= 1
        if nxt is not None:
            assert e0 <= nxt[0] + 1e-9


# --------------------------------------------------------------------------- helpers


def test_hysteresis_keeps_runs_that_reach_the_high_threshold() -> None:
    x = np.array([0.0, 0.25, 0.35, 0.6, 0.35, 0.25, 0.1, 0.35, 0.4, 0.35, 0.0])
    got = segment.hysteresis(x, 0.3, 0.5)
    assert got.tolist() == [False, False, True, True, True, False, False, False, False, False, False]


def test_tuning_wraps_around_the_semitone() -> None:
    rng = np.random.default_rng(1)
    for cents in (-49.0, 49.0, 15.0):
        m = np.repeat(np.array([60, 62, 64, 65, 67]), 60) + cents / 100 + rng.normal(0, 0.05, 300)
        got = segment.estimate_tuning(m, np.ones(300, bool), np.ones(300))
        assert abs(((got - cents) + 50) % 100 - 50) <= 3.0


# --------------------------------------------------------------------------- pitch decoding (numpy only)


def _salience(midis: list[float], width: float = 1.2) -> np.ndarray:
    bins = np.arange(pitch.BINS)
    centers = [pitch.midi_to_bin(m) for m in midis]
    return np.stack([0.9 * np.exp(-0.5 * ((bins - c) / width) ** 2) for c in centers]).astype(np.float32)


def test_decode_gives_sub_bin_precision() -> None:
    truth = np.repeat([60.0, 60.07, 60.13, 61.55, 70.31, 45.9], 6)  # steps, a leap up, a leap down
    track = pitch.decode(_salience(list(truth)), np.ones(len(truth), bool))
    assert np.allclose(track.midi, truth, atol=0.02)
    assert np.all(track.periodicity > 0.5)


def test_viterbi_ignores_octave_blips_but_follows_leaps() -> None:
    blip = [60.0] * 10 + [72.0] * 2 + [60.0] * 10
    track = pitch.decode(_salience(blip), np.ones(len(blip), bool))
    assert np.all(np.abs(track.midi - 60.0) < 0.1)
    leap = [60.0] * 10 + [67.0] * 10
    track = pitch.decode(_salience(leap), np.ones(len(leap), bool))
    assert np.all(np.abs(track.midi[:10] - 60.0) < 0.1) and np.all(np.abs(track.midi[10:] - 67.0) < 0.1)


def test_decode_skips_inactive_frames() -> None:
    sal = _salience([60.0] * 6)
    active = np.array([True, True, False, False, True, True])
    track = pitch.decode(sal, active)
    assert np.isnan(track.midi[2:4]).all() and (track.periodicity[2:4] == 0).all()
    assert np.isfinite(track.midi[[0, 1, 4, 5]]).all()


def test_frame_grid_and_onset_curve() -> None:
    sr = 16000
    x = np.zeros(sr, dtype=np.float32)
    x[8000:] = 0.3 * np.sin(2 * np.pi * 220 * np.arange(8000) / sr)
    energy = pitch.frame_rms_db(x)
    flux = onset_strength(x)
    assert len(energy) == len(flux) == pitch.n_frames(len(x)) == 101
    assert energy[20] < -100 and energy[80] > -15
    assert int(np.argmax(flux)) in range(49, 54)  # the tone starts at 0.5 s


def test_separation_block_plan() -> None:
    sr = 44100
    assert plan_blocks(10 * sr) == [(0, 10 * sr)]
    assert plan_blocks(170 * sr) == [(0, 170 * sr)]  # < 1.5 blocks: one block
    blocks = plan_blocks(400 * sr)
    assert len(blocks) == 3 and blocks[0][0] == 0 and blocks[-1][1] == 400 * sr
    assert all(a[1] == b[0] for a, b in zip(blocks, blocks[1:]))
    assert max(b - a for a, b in blocks) <= 180 * sr
