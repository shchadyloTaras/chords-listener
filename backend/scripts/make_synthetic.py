"""Synthesize test songs with KNOWN chord ground truth.

Each song is rendered from a chord progression with additive piano / guitar / pad tones
(harmonics, inharmonicity, per-partial decays), varied voicings and inversions, strumming
or arpeggio patterns, a bass line (incl. walking/approach notes), drum-like noise hits,
a monophonic melody with passing tones, light reverb, and optional detuning.

Usage (from backend/):
    uv run python scripts/make_synthetic.py --out /path/to/dir [--only NAME ...]

Writes ``<name>.wav`` (44.1 kHz, 16-bit mono) and ``<name>.json`` with the ground truth:
``{"chords": [{"start", "end", "label"}...], "beats", "downbeats", "tempo", "timeSignature",
"key", "duration"}``. Labels follow docs/SPEC.md (sharps, ``N`` for silence).
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.signal import fftconvolve, lfilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.chords import QUALITIES, parse_label, pitch_class  # noqa: E402

SR = 44100

MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
MINOR_SCALE = (0, 2, 3, 5, 7, 8, 10)


@dataclass
class SongSpec:
    name: str
    tonic: str
    mode: str  # "major" | "minor"
    tempo: float
    beats_per_bar: int
    instrument: str  # "piano" | "guitar" | "pad" | "mix"
    progression: list[tuple[str, float]]  # (label, beats); "N" = silent break
    seed: int = 0
    lead_in: float = 1.0
    melody: bool = True
    drums: bool = True
    piano_style: str = "block"  # "block" | "arpeggio" | "waltz" | "comp"
    bass_style: str = "root"  # "root" | "walking"
    tuning_cents: float = 0.0
    extras: dict = field(default_factory=dict)


# --------------------------------------------------------------------------------------
# tones


def midi_hz(m: float, tuning_cents: float = 0.0) -> float:
    return 440.0 * 2.0 ** ((m - 69 + tuning_cents / 100.0) / 12.0)


def _env(n_on: int, n_rel: int, attack: float) -> np.ndarray:
    n = n_on + n_rel
    env = np.ones(n)
    na = max(1, min(int(attack * SR), n_on))
    env[:na] = np.linspace(0.0, 1.0, na)
    if n_rel:
        env[n_on:] = np.cos(np.linspace(0, np.pi / 2, n_rel)) ** 2
    return env


def partial_tone(f0: float, dur: float, amps, decays, rng: np.random.Generator, *, inharm: float = 0.0,
                 attack: float = 0.005, release: float = 0.06, vibrato: float = 0.0,
                 max_len: float = 6.0) -> np.ndarray:
    dur = min(dur, max_len)
    n_on = max(1, int(dur * SR))
    n_rel = int(release * SR)
    n = n_on + n_rel
    t = np.arange(n) / SR
    out = np.zeros(n)
    vib = None
    if vibrato:
        vib = 1.0 + vibrato * np.sin(2 * np.pi * 5.2 * t + rng.uniform(0, 6.28)) * np.clip(t / 0.3, 0, 1)
    for k, (a, tau) in enumerate(zip(amps, decays), start=1):
        fk = k * f0 * np.sqrt(1.0 + inharm * k * k)
        if fk > 0.45 * SR or a <= 0:
            continue
        if vib is not None:
            phase = 2 * np.pi * np.cumsum(fk * vib) / SR
        else:
            phase = 2 * np.pi * fk * t
        out += a * np.sin(phase + rng.uniform(0, 2 * np.pi)) * np.exp(-t / tau)
    return out * _env(n_on, n_rel, attack)


def piano_note(f0: float, dur: float, vel: float, rng) -> np.ndarray:
    k = np.arange(1, 13)
    amps = (1.0 / k ** 1.1) * np.where(k % 2 == 0, 0.8, 1.0) * np.exp(-k * f0 / 6000.0)
    tau0 = float(np.clip(1.3 * (261.0 / f0) ** 0.6, 0.35, 4.0))
    decays = tau0 / (1.0 + 0.3 * (k - 1))
    return vel * partial_tone(f0, dur, amps, decays, rng, inharm=1.2e-4, attack=0.004, release=0.08)


def guitar_note(f0: float, dur: float, vel: float, rng) -> np.ndarray:
    k = np.arange(1, 16)
    p = 0.17 + rng.uniform(-0.03, 0.03)
    amps = np.abs(np.sin(np.pi * k * p)) / k ** 0.95
    tau0 = float(np.clip(1.0 * (196.0 / f0) ** 0.5, 0.3, 2.5))
    decays = tau0 / (1.0 + 0.45 * (k - 1))
    return vel * partial_tone(f0, dur, amps, decays, rng, inharm=4e-5, attack=0.002, release=0.05)


def pad_note(f0: float, dur: float, vel: float, rng) -> np.ndarray:
    k = np.arange(1, 7)
    amps = 1.0 / k ** 1.6
    decays = np.full(6, 30.0)
    a = partial_tone(f0 * 2 ** (4 / 1200), dur, amps, decays, rng, attack=0.18, release=0.3)
    b = partial_tone(f0 * 2 ** (-4 / 1200), dur, amps, decays, rng, attack=0.18, release=0.3)
    return vel * 0.5 * (a + b)


def bass_note(f0: float, dur: float, vel: float, rng) -> np.ndarray:
    amps = np.array([1.0, 0.65, 0.38, 0.22, 0.12, 0.07])
    decays = np.array([1.6, 1.2, 0.9, 0.7, 0.5, 0.4])
    return vel * partial_tone(f0, dur, amps, decays, rng, attack=0.006, release=0.07)


def flute_note(f0: float, dur: float, vel: float, rng) -> np.ndarray:
    amps = np.array([1.0, 0.45, 0.22, 0.11, 0.05])
    decays = np.full(5, 12.0)
    tone = partial_tone(f0, dur, amps, decays, rng, attack=0.035, release=0.07, vibrato=0.004)
    breath = rng.standard_normal(len(tone)) * 0.015 * np.exp(-np.arange(len(tone)) / (0.05 * SR))
    return vel * (tone + breath)


def kick(rng) -> np.ndarray:
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    f = 50 + 70 * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09)


def snare(rng) -> np.ndarray:
    n = int(0.2 * SR)
    t = np.arange(n) / SR
    noise = lfilter([1, -0.6], [1], rng.standard_normal(n))
    return 0.5 * noise * np.exp(-t / 0.06) + 0.4 * np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.04)


def hihat(rng, open_: bool = False) -> np.ndarray:
    n = int((0.18 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    noise = np.diff(rng.standard_normal(n + 1))
    return 0.25 * noise * np.exp(-t / (0.06 if open_ else 0.015))


# --------------------------------------------------------------------------------------
# rendering


class Track:
    def __init__(self, seconds: float):
        self.buf = np.zeros(int(seconds * SR) + SR * 8)

    def add(self, sig: np.ndarray, at: float, gain: float = 1.0) -> None:
        i = int(round(at * SR))
        if i < 0:
            sig, i = sig[-i:], 0
        j = min(len(self.buf), i + len(sig))
        self.buf[i:j] += gain * sig[: j - i]


def voicing_piano(pcs: list[int], bass_pc: int, rng) -> list[int]:
    """Close-position right-hand voicing around C4 with a random inversion."""
    start = 55 + int(rng.integers(0, 8))
    notes = []
    order = list(pcs)
    rot = int(rng.integers(0, len(order)))
    order = order[rot:] + order[:rot]
    cur = start
    for pc in order:
        m = cur + ((pc - cur) % 12)
        notes.append(m)
        cur = m + 1
    return sorted(notes)


GUITAR_STRINGS = (40, 45, 50, 55, 59, 64)


def voicing_guitar(pcs: list[int], bass_pc: int, rng) -> list[int]:
    """Guitar-like voicing: bass on a low string, then the nearest chord tone 0..4 frets up each string."""
    low = 40 + ((bass_pc - 40) % 12)
    if low > 47:
        low -= 12 if low - 12 >= 38 else 0
    notes = [low]
    for s in GUITAR_STRINGS:
        if s <= low:
            continue
        cands = [s + f for f in range(0, 5) if (s + f) % 12 in pcs and s + f > notes[-1]]
        if cands:
            notes.append(cands[0] if rng.random() < 0.8 else cands[-1])
    if len({n % 12 for n in notes}) < len(set(pcs)):  # make sure every chord tone sounds
        missing = [pc for pc in pcs if pc not in {n % 12 for n in notes}]
        for pc in missing:
            notes.append(60 + ((pc - 60) % 12))
    return sorted(set(notes))


def render(spec: SongSpec) -> tuple[np.ndarray, dict]:
    rng = np.random.default_rng(spec.seed)
    beat = 60.0 / spec.tempo
    bpb = spec.beats_per_bar
    tonic_pc = pitch_class(spec.tonic)
    scale = [(tonic_pc + s) % 12 for s in (MAJOR_SCALE if spec.mode == "major" else MINOR_SCALE)]

    total_beats = sum(b for _, b in spec.progression)
    song_end = spec.lead_in + total_beats * beat
    tail = 2.0
    duration = song_end + tail

    harm = Track(duration)
    bass = Track(duration)
    drums = Track(duration)
    mel = Track(duration)
    tune = spec.tuning_cents

    def hz(m: float) -> float:
        return midi_hz(m, tune)

    truth: list[dict] = []
    if spec.lead_in > 0:
        truth.append({"start": 0.0, "end": spec.lead_in, "label": "N"})

    t = spec.lead_in
    beat_idx = 0
    prev_mel = 72 + ((tonic_pc - 72) % 12)
    instrument_cycle = 0
    for ci, (label, n_beats) in enumerate(spec.progression):
        c_start, c_end = t, t + n_beats * beat
        chord = parse_label(label)
        if truth and truth[-1]["label"] == label:
            truth[-1]["end"] = c_end
        else:
            truth.append({"start": c_start, "end": c_end, "label": label})
        if chord.is_none:
            t, beat_idx = c_end, beat_idx + int(round(n_beats))
            continue
        pcs = list(chord.pitch_classes())
        bass_pc = chord.bass if chord.bass is not None else chord.root
        instrument = spec.instrument
        if instrument == "mix":
            instrument = ("piano", "guitar")[instrument_cycle % 2]
            instrument_cycle += 1

        # ---- harmony
        beat_times = [c_start + k * beat for k in range(int(round(n_beats)))]
        if instrument == "guitar":
            notes = voicing_guitar(pcs, bass_pc, rng)
            pattern_44 = [("D", 0.0), ("D", 1.0), ("U", 1.5), ("U", 2.5), ("D", 3.0), ("U", 3.5)]
            pattern_34 = [("D", 0.0), ("D", 1.0), ("U", 1.5), ("D", 2.0), ("U", 2.5)]
            pattern = pattern_34 if bpb == 3 else pattern_44
            strums = []
            for k, bt in enumerate(beat_times):
                pos_in_bar = (beat_idx + k) % bpb
                for kind, off in pattern:
                    if int(off) == pos_in_bar:
                        strums.append((kind, bt + (off - int(off)) * beat))
            for si, (kind, st) in enumerate(strums):
                nxt = strums[si + 1][1] if si + 1 < len(strums) else c_end
                dur = max(0.08, nxt - st + 0.02)
                seq = notes if kind == "D" else list(reversed(notes[-4:]))
                gap = rng.uniform(0.008, 0.016) if kind == "D" else rng.uniform(0.006, 0.011)
                vel = (0.9 if kind == "D" else 0.55) * rng.uniform(0.85, 1.05)
                for k, m in enumerate(seq):
                    harm.add(guitar_note(hz(m), dur - k * gap, vel * 0.33, rng), st + k * gap + rng.normal(0, 0.003))
        elif instrument == "pad":
            notes = voicing_piano(pcs, bass_pc, rng)
            for m in notes:
                harm.add(pad_note(hz(m), c_end - c_start, 0.32, rng), c_start)
            # light piano arpeggio on top
            for k, bt in enumerate(beat_times):
                m = notes[k % len(notes)] + 12
                harm.add(piano_note(hz(m), beat * 0.9, 0.18, rng), bt)
        else:  # piano
            notes = voicing_piano(pcs, bass_pc, rng)
            style = spec.piano_style
            if style == "arpeggio":
                lh = 36 + ((bass_pc - 36) % 12)
                arp = [lh, lh + 7 if (bass_pc + 7) % 12 in pcs else lh + 12] + notes
                n_eighths = int(round(n_beats * 2))
                seq = [arp[0], arp[1], arp[2], arp[3 % len(arp)], arp[-1], arp[3 % len(arp)], arp[2], arp[1]]
                for k in range(n_eighths):
                    st = c_start + k * beat / 2
                    harm.add(piano_note(hz(seq[k % len(seq)]), c_end - st, 0.45, rng), st + rng.normal(0, 0.004))
            elif style == "waltz":
                for k, bt in enumerate(beat_times):
                    pos = (beat_idx + k) % bpb
                    if pos == 0:
                        continue  # bass instrument plays beat 1
                    for m in notes:
                        harm.add(piano_note(hz(m), beat * 0.8, 0.4, rng), bt + rng.normal(0, 0.004))
            elif style == "comp":
                hits = []
                for k, bt in enumerate(beat_times):
                    pos = (beat_idx + k) % bpb
                    if pos in (0, 2):
                        hits.append(bt)
                    if pos == 1 and rng.random() < 0.5:
                        hits.append(bt + beat / 2)
                for hi, st in enumerate(hits):
                    nxt = hits[hi + 1] if hi + 1 < len(hits) else c_end
                    for m in notes:
                        harm.add(piano_note(hz(m), max(0.15, (nxt - st) * 0.85), 0.4, rng), st + rng.normal(0, 0.005))
            else:  # block
                for k, bt in enumerate(beat_times):
                    pos = (beat_idx + k) % bpb
                    if pos % 2 == 0 or rng.random() < 0.25:
                        dur = min(2 * beat, c_end - bt)
                        for m in notes:
                            harm.add(piano_note(hz(m), dur, 0.42, rng), bt + rng.normal(0, 0.004))

        # ---- bass
        root_m = 33 + ((bass_pc - 33) % 12)  # A1..G#2
        fifth_pc = (chord.root + QUALITIES[chord.quality][0][2]) % 12
        nxt_label = spec.progression[ci + 1][0] if ci + 1 < len(spec.progression) else label
        nxt_chord = parse_label(nxt_label)
        for k, bt in enumerate(beat_times):
            pos = (beat_idx + k) % bpb
            if spec.bass_style == "walking":
                if k == 0:
                    m = root_m
                elif k == len(beat_times) - 1 and not nxt_chord.is_none:
                    target = 33 + ((nxt_chord.root - 33) % 12)
                    m = target + (1 if rng.random() < 0.5 else -1)  # chromatic approach note
                else:
                    m = 33 + ((rng.choice(pcs) - 33) % 12)
                bass.add(bass_note(hz(m), beat * 0.95, 0.75, rng), bt)
            else:
                if pos == 0 or k == 0:
                    bass.add(bass_note(hz(root_m), beat * (1.6 if bpb == 4 else 0.9), 0.8, rng), bt)
                elif bpb == 4 and pos == 2:
                    m = root_m if rng.random() < 0.6 else 33 + ((fifth_pc - 33) % 12)
                    bass.add(bass_note(hz(m), beat * 1.6, 0.7, rng), bt)

        # ---- drums
        if spec.drums:
            for k, bt in enumerate(beat_times):
                pos = (beat_idx + k) % bpb
                if bpb == 3:
                    if pos == 0:
                        drums.add(kick(rng), bt, 0.8)
                    else:
                        drums.add(hihat(rng), bt, 0.9)
                        drums.add(snare(rng), bt, 0.25)
                else:
                    if pos in (0, 2):
                        drums.add(kick(rng), bt, 0.9)
                    if pos in (1, 3):
                        drums.add(snare(rng), bt, 0.7)
                    drums.add(hihat(rng, open_=(pos == 3 and rng.random() < 0.3)), bt, 0.8)
                    drums.add(hihat(rng), bt + beat / 2, 0.5)

        # ---- melody (chord tones on strong beats, scale steps elsewhere)
        if spec.melody:
            k = 0.0
            while k < n_beats - 1e-6:
                st = c_start + k * beat
                pos = (beat_idx + int(k)) % bpb
                dur_b = float(rng.choice([0.5, 1.0, 1.0, 2.0])) if k + 1 <= n_beats else 0.5
                dur_b = min(dur_b, n_beats - k)
                if rng.random() < 0.18:
                    k += dur_b
                    continue
                if k == int(k) and pos % 2 == 0:
                    cands = [m for m in range(67, 86) if m % 12 in pcs]
                else:
                    cands = [m for m in range(67, 86) if m % 12 in scale]
                cands.sort(key=lambda m: abs(m - prev_mel) + rng.uniform(0, 2.5))
                m = cands[0]
                prev_mel = m
                mel.add(flute_note(hz(m), dur_b * beat * 0.95, 0.5, rng), st)
                k += dur_b
        t, beat_idx = c_end, beat_idx + int(round(n_beats))

    # the last chord rings a little past the final bar, then the file is silent
    if truth and truth[-1]["label"] != "N":
        truth[-1]["end"] = song_end + 0.25
        truth.append({"start": song_end + 0.25, "end": duration, "label": "N"})

    mix = 1.0 * harm.buf + 0.85 * bass.buf + (0.45 * drums.buf) + 0.55 * mel.buf
    # light reverb
    ir_n = int(1.2 * SR)
    ir_t = np.arange(ir_n) / SR
    ir = rng.standard_normal(ir_n) * np.exp(-ir_t / 0.22)
    ir = lfilter([0.25], [1, -0.75], ir)
    ir /= np.sqrt(np.sum(ir ** 2))
    wet = fftconvolve(mix, ir)[: len(mix)]
    mix = mix + 0.18 * wet
    mix = mix[: int(duration * SR)]
    # kill anything before the lead-in (reverb pre-delay rounding)
    mix[: int(spec.lead_in * SR)] = 0.0
    mix = 0.89 * mix / (np.max(np.abs(mix)) + 1e-9)

    beats = [spec.lead_in + i * beat for i in range(int(round(total_beats)))]
    downbeats = beats[::bpb]
    truth_dict = {
        "name": spec.name,
        "chords": [{"start": round(c["start"], 4), "end": round(c["end"], 4), "label": c["label"]} for c in truth],
        "beats": [round(b, 4) for b in beats],
        "downbeats": [round(b, 4) for b in downbeats],
        "tempo": spec.tempo,
        "timeSignature": bpb,
        "key": spec.tonic + ("m" if spec.mode == "minor" else ""),
        "duration": round(duration, 4),
        "tuningCents": spec.tuning_cents,
    }
    return mix.astype(np.float32), truth_dict


# --------------------------------------------------------------------------------------
# the test set


def _p(text: str) -> list[tuple[str, float]]:
    """Parse "C:4 G:4 Am:2 ..." into (label, beats) pairs."""
    out = []
    for tok in text.split():
        label, beats = tok.rsplit(":", 1)
        out.append((label, float(beats)))
    return out


SONGS: list[SongSpec] = [
    SongSpec("pop_c_piano", "C", "major", 100, 4, "piano", _p(
        "C:4 G:4 Am:4 F:4 C:4 G/B:4 Am:4 F:4 Dm:4 G:4 C:4 Am:4 F:4 G:4 C:8"), seed=1, piano_style="block"),
    SongSpec("folk_g_guitar", "G", "major", 116, 4, "guitar", _p(
        "G:4 Em:4 C:4 D:4 G:4 Em:4 C:2 D:2 G:4 C:4 G:4 D:4 Em:4 C:4 D:4 G:8"), seed=2),
    SongSpec("jazz_f_sevenths", "F", "major", 92, 4, "piano", _p(
        "Gm7:4 C7:4 Fmaj7:4 Dm7:4 Gm7:4 C7:4 Fmaj7:4 D7:4 Gm7:4 C7:4 Am7:4 Dm7:4 Gm7:4 C7:4 Fmaj7:8"),
        seed=3, piano_style="comp", bass_style="walking"),
    SongSpec("waltz_d_34", "D", "major", 150, 3, "piano", _p(
        "D:6 A:6 Bm:6 G:3 A7:3 D:3 F#m:3 G:3 A:3 Bm:3 G:3 A7:3 D:6"), seed=4, piano_style="waltz"),
    SongSpec("minor_b_guitar", "B", "minor", 84, 4, "guitar", _p(
        "Bm:4 G:4 D:4 A:4 Bm:4 G:4 Asus4:2 A:2 F#7:4 Bm:4 Em:4 F#m:4 G:4 A:4 Bm:8"), seed=5),
    SongSpec("rock_e_detuned", "E", "major", 138, 4, "guitar", _p(
        "E:4 A:4 B:4 A:4 C#m:4 A:4 Bsus4:2 B:2 E:4 E:2 Esus2:2 A:4 B:4 C#m:4 A:4 B:4 E:8"),
        seed=6, tuning_cents=28.0),
    SongSpec("ballad_eb_pad", "D#", "major", 72, 4, "pad", _p(
        "D#:4 Cm:4 G#:4 A#:4 D#:4 D#aug:4 G#:4 G#m:4 D#:4 Cm:4 Fm:4 A#:4 Gm:4 Cm:4 Fm:2 A#7:2 D#:8"), seed=7),
    SongSpec("a_minor_mix_break", "A", "minor", 108, 4, "mix", _p(
        "Am:4 Am/G:4 F:4 E:4 Am:4 Dm:4 E7:4 Am:4 N:4 C:4 G:4 F:4 E:4 Am:4 Bdim:2 E:2 Am:8"),
        seed=8, piano_style="arpeggio"),
]

TEST_SONG = SongSpec("unit_test_song", "G", "major", 120, 4, "piano", _p(
    "G:4 Em:4 C:4 D:4 G:4 C:4 D7:4 G:4"), seed=11, piano_style="block", lead_in=0.8)


_MAJOR_DEGREES = {  # degree (semitones from tonic) -> (triad quality, seventh quality)
    0: ("maj", "maj7"), 2: ("min", "min7"), 4: ("min", "min7"), 5: ("maj", "maj7"), 7: ("maj", "7"),
    9: ("min", "min7"), 11: ("dim", "dim"),
}
_MINOR_DEGREES = {
    0: ("min", "min7"), 2: ("dim", "dim"), 3: ("maj", "maj7"), 5: ("min", "min7"), 7: ("maj", "7"),
    8: ("maj", "maj7"), 10: ("maj", "7"),
}
_MOVES_MAJOR = {0: [5, 7, 9, 2, 4], 2: [7, 5, 11], 4: [9, 5], 5: [7, 0, 2], 7: [0, 9, 5], 9: [5, 2, 7, 4], 11: [0, 4]}
_MOVES_MINOR = {0: [8, 5, 7, 3, 10], 2: [7], 3: [8, 10, 5], 5: [7, 0, 10], 7: [0, 8], 8: [10, 3, 5, 7], 10: [3, 0, 8]}


def random_song(seed: int) -> SongSpec:
    """A random but musically plausible song (used as a held-out validation set)."""
    rng = np.random.default_rng(10_000 + seed)
    from app.engine.chords import PITCH_NAMES, format_label

    tonic = int(rng.integers(0, 12))
    mode = "major" if rng.random() < 0.7 else "minor"
    degrees, moves = (_MAJOR_DEGREES, _MOVES_MAJOR) if mode == "major" else (_MINOR_DEGREES, _MOVES_MINOR)
    bpb = 3 if rng.random() < 0.15 else 4
    tempo = float(rng.integers(68, 152))
    prog: list[tuple[str, float]] = []
    deg = 0
    n_chords = int(rng.integers(12, 17))
    for i in range(n_chords):
        q3, q7 = degrees[deg]
        root = (tonic + deg) % 12
        r = rng.random()
        bar = float(bpb)
        if i == n_chords - 1:
            deg, root, q3 = 0, tonic, degrees[0][0]
            prog.append((format_label(root, q3), 2 * bar))
            break
        if r < 0.14 and q7 != q3:
            prog.append((format_label(root, q7), bar))
        elif r < 0.2 and q3 == "maj" and bpb == 4:
            prog.append((format_label(root, "sus4"), 2.0))
            prog.append((format_label(root, "maj"), 2.0))
        elif r < 0.25 and q3 in ("maj", "min"):
            third = (root + (4 if q3 == "maj" else 3)) % 12
            prog.append((format_label(root, q3, third), bar))
        elif r < 0.37 and bpb == 4:
            nxt = int(rng.choice(moves[deg]))
            prog.append((format_label(root, q3), 2.0))
            nroot = (tonic + nxt) % 12
            prog.append((format_label(nroot, degrees[nxt][0]), 2.0))
            deg = nxt
        else:
            prog.append((format_label(root, q3), bar * (2 if rng.random() < 0.12 else 1)))
        deg = int(rng.choice(moves[deg]))
    instrument = str(rng.choice(["piano", "guitar", "pad", "mix"]))
    style = "waltz" if bpb == 3 and instrument == "piano" else str(rng.choice(["block", "arpeggio", "comp"]))
    return SongSpec(
        name=f"random_{seed:02d}", tonic=PITCH_NAMES[tonic], mode=mode, tempo=tempo, beats_per_bar=bpb,
        instrument=instrument, progression=prog, seed=20_000 + seed, lead_in=float(rng.uniform(0.4, 1.6)),
        melody=bool(rng.random() < 0.85), drums=bool(rng.random() < 0.8), piano_style=style,
        bass_style="walking" if rng.random() < 0.15 else "root",
        tuning_cents=float(rng.uniform(-35, 35)) if rng.random() < 0.35 else 0.0)


def write_song(spec: SongSpec, out_dir: Path) -> tuple[Path, Path]:
    import soundfile as sf

    audio, truth = render(spec)
    out_dir.mkdir(parents=True, exist_ok=True)
    wav = out_dir / f"{spec.name}.wav"
    js = out_dir / f"{spec.name}.json"
    sf.write(str(wav), audio, SR, subtype="PCM_16")
    js.write_text(json.dumps(truth, indent=1))
    return wav, js


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--only", nargs="*", help="song names to render (default: all)")
    ap.add_argument("--random", type=int, default=0, metavar="N",
                    help="render N random songs (held-out set) instead of the fixed set")
    args = ap.parse_args()
    specs = [random_song(i) for i in range(args.random)] if args.random else SONGS
    for spec in specs:
        if args.only and spec.name not in args.only:
            continue
        wav, _ = write_song(spec, args.out)
        print(f"wrote {wav}")


if __name__ == "__main__":
    main()
