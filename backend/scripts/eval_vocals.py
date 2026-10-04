"""Evaluate the vocal melody transcription (app.vocals) on synthetic songs with known notes, or
summarize a real recording.

Usage (from backend/, needs the optional extra):
    uv run --extra vocals python scripts/eval_vocals.py [--out DIR] [--only NAME ...] [--device cpu|mps]
                                                         [--crepe tiny|full] [--cache DIR]
    uv run --extra vocals python scripts/eval_vocals.py --resegment DIR     # segmentation only, from --cache
    uv run --extra vocals python scripts/eval_vocals.py --real song.mp3 [--png roll.png]

Synthetic set: the accompaniments of scripts/make_synthetic.py (chords, bass, drums; its flute melody
is turned off) with a rendered "singing" voice mixed 3–6 dB above them. The voice is a harmonic
source shaped by vowel formants, with 5–6 Hz vibrato of ±30–60 cents, 30–80 ms portamento, scoops into
notes, consonant noise bursts, voiced re-articulations of repeated notes (energy dips), breath noise
in the gaps between phrases, small intonation errors and timing jitter, a global tuning offset
(e.g. +25 cents) and a little reverb. Ground truth = the intended notes (integer MIDI, i.e. before
the tuning offset), onset = start of phonation / middle of a slide or a re-articulation dip.

Metrics (mir_eval.transcription; pitch tolerance 50 cents, onset tolerance 50 ms):
  onF     onset-only F-measure (P / R)
  onoffF  onset + offset F-measure (offset ratio 0.2, at least 50 ms)
  pitch   share of the notes matched by onset alone (any pitch) whose pitch is right (±50 cents)
  RPA     raw pitch accuracy of the f0 contour on frames voiced in both (±50 cents, before tuning)
  VR/VFA  frame voicing recall / false alarm
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import shutil
import struct
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import make_synthetic as synth  # noqa: E402

from app.engine.chords import parse_label, pitch_class  # noqa: E402
from app.vocals import segment as seg_mod  # noqa: E402

SR = 44100
CR = 1000  # control rate of the voice model (1 ms)
HOP = 0.01

# formant frequencies / bandwidths (Hz) of a male voice; female voices scale F1..F3 up
VOWELS = {
    "a": ((730, 1090, 2440, 3300, 3750), (80, 90, 120, 200, 250)),
    "e": ((530, 1840, 2480, 3300, 3750), (60, 100, 120, 200, 250)),
    "i": ((300, 2200, 3010, 3300, 3750), (60, 90, 100, 200, 250)),
    "o": ((570, 840, 2410, 3300, 3750), (70, 80, 100, 200, 250)),
    "u": ((330, 870, 2240, 3300, 3750), (60, 80, 100, 200, 250)),
}
FEMALE = np.array([1.17, 1.15, 1.1, 1.05, 1.05])
VOICED_CONS = {  # voiced consonants: formant locus, nasal murmur
    "m": ((250, 1000, 2200, 3300, 3750), 1.0),
    "n": ((250, 1500, 2500, 3300, 3750), 1.0),
    "l": ((360, 1300, 2900, 3300, 3750), 0.0),
    "w": ((300, 700, 2200, 3300, 3750), 0.0),
    "j": ((280, 2200, 3000, 3300, 3750), 0.0),
}
UNVOICED_CONS = {  # noise band (Hz), duration range (s), level vs the vowel
    "s": ((3800, 9000), (0.05, 0.09), 0.35),
    "sh": ((2000, 6000), (0.05, 0.09), 0.35),
    "t": ((2000, 8000), (0.03, 0.05), 0.45),
    "k": ((1200, 4000), (0.03, 0.05), 0.4),
    "f": ((1000, 8000), (0.04, 0.08), 0.18),
    "p": ((300, 6000), (0.03, 0.045), 0.35),
}

# per song: voice range, tuning offset (cents), voice level above the accompaniment (dB)
VOICES = [
    ("male", (48, 67), 25.0, 4.0),
    ("female", (57, 76), -15.0, 3.0),
    ("male", (47, 65), 10.0, 6.0),
    ("female", (58, 77), 40.0, 5.0),
    ("male", (50, 69), -30.0, 3.5),
    ("female", (55, 74), 25.0, 4.5),
    ("male", (45, 64), 0.0, 5.5),
    ("female", (57, 76), -5.0, 3.0),
]


@dataclass
class SungNote:
    onset: float
    offset: float
    midi: int
    vowel: str
    trans: str  # how this note starts: rest | slide | consonant | dip
    trans_len: float = 0.0  # slide length / consonant gap / dip width (s)
    cons: str = ""  # consonant before the vowel ("" = vowel onset, "h" = breathy onset)
    scoop: float = 0.0  # cents below the target at the start
    scoop_time: float = 0.07
    vib_rate: float = 5.5
    vib_depth: float = 0.0  # cents (half the peak-to-peak swing)
    vib_delay: float = 0.2
    err: float = 0.0  # intonation error, cents
    dip_db: float = 0.0
    level: float = 1.0


# --------------------------------------------------------------------------- melody


def _chord_at(spec: synth.SongSpec, beat_pos: float):
    acc = 0.0
    for label, beats in spec.progression:
        if acc <= beat_pos < acc + beats:
            return parse_label(label)
        acc += beats
    return parse_label(spec.progression[-1][0])


def compose(spec: synth.SongSpec, rng: np.random.Generator, lo: int, hi: int) -> list[SungNote]:
    """A singable melody over the song's chords: 2–4 bar phrases with breath rests, mostly steps,
    some leaps, ~20 % repeated notes; every note is a syllable (consonant + vowel) or a slide."""
    beat = 60.0 / spec.tempo
    total = sum(b for _, b in spec.progression)
    tonic = pitch_class(spec.tonic)
    scale = {(tonic + s) % 12 for s in (synth.MAJOR_SCALE if spec.mode == "major" else synth.MINOR_SCALE)}
    bpb = spec.beats_per_bar
    notes: list[SungNote] = []
    prev = int(np.clip((lo + hi) // 2, lo, hi))
    b = 0.0
    while b < total - bpb:
        phrase = min(float(bpb * (4 if rng.random() < 0.3 else 2)), total - b)
        k = b + (0.5 if rng.random() < 0.3 else 0.0)
        end = b + phrase - float(rng.choice([0.5, 1.0, 1.0, 1.5]))
        first = True
        while k < end - 0.25:
            dur = min(float(rng.choice([0.5, 1.0, 1.0, 1.0, 1.5, 2.0])), end - k)
            if dur * beat < 0.14:
                break
            chord = _chord_at(spec, k)
            strong = abs(k - round(k)) < 1e-6 and int(round(k)) % 2 == 0
            pcs = set(chord.pitch_classes()) if (strong and not chord.is_none) else scale
            r = rng.random()
            if not first and r < 0.2 and prev % 12 in scale:
                m = prev
            else:
                if r < 0.75:
                    target = prev + int(rng.choice([-2, -1, 1, 2]))
                else:
                    target = prev + int(rng.choice([-1, 1])) * int(rng.integers(3, 10))
                cands = [x for x in range(lo, hi + 1) if x % 12 in pcs and x != prev] or [prev]
                m = min(cands, key=lambda x: abs(x - target) + rng.uniform(0, 0.8))
            on = spec.lead_in + k * beat + rng.normal(0, 0.012)
            off = spec.lead_in + (k + dur) * beat + rng.normal(0, 0.012)
            if first:
                trans = "rest"
            elif m == prev:
                trans = "dip" if rng.random() < 0.5 else "consonant"
            else:
                trans = str(rng.choice(["slide", "consonant", "dip"], p=[0.3, 0.4, 0.3]))
            n = SungNote(onset=on, offset=off, midi=m, vowel=str(rng.choice(list(VOWELS))), trans=trans,
                         err=float(rng.normal(0, 8)), level=float(10 ** (rng.uniform(-3, 2) / 20)))
            if trans == "rest":
                kind = rng.choice(["", "h", "unvoiced", "voiced"], p=[0.3, 0.1, 0.35, 0.25])
                n.cons = (str(rng.choice(list(UNVOICED_CONS))) if kind == "unvoiced" else
                          str(rng.choice(list(VOICED_CONS))) if kind == "voiced" else str(kind))
                if n.cons in UNVOICED_CONS:
                    n.trans_len = float(rng.uniform(*UNVOICED_CONS[n.cons][1]))
            elif trans == "slide":
                n.trans_len = float(rng.uniform(0.03, 0.08))
            elif trans == "dip":
                n.cons = str(rng.choice(list(VOICED_CONS)))
                n.trans_len = float(rng.uniform(0.05, 0.08))
                n.dip_db = float(rng.uniform(9, 15))
            else:
                n.cons = str(rng.choice(list(UNVOICED_CONS)))
                n.trans_len = float(rng.uniform(*UNVOICED_CONS[n.cons][1]))
            if trans in ("rest", "consonant") and n.cons not in VOICED_CONS and rng.random() < 0.25:
                n.scoop = float(rng.uniform(70, 150))
                n.scoop_time = float(rng.uniform(0.05, 0.09))
            if (off - on) > 0.35:
                n.vib_rate = float(rng.uniform(5.0, 6.0))
                n.vib_depth = float(rng.uniform(30, 60))
                n.vib_delay = float(rng.uniform(0.12, 0.25))
            if notes and not first:
                notes[-1].offset = n.onset - n.trans_len if trans == "consonant" else n.onset
            notes.append(n)
            prev, first = m, False
            k += dur
        b += phrase
    return notes


# --------------------------------------------------------------------------- voice rendering


def _smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def _lp_noise(n: int, cutoff: float, rng: np.random.Generator, fs: float = SR) -> np.ndarray:
    x = sosfilt(butter(2, cutoff, fs=fs, output="sos"), rng.standard_normal(n))
    return x / (x.std() + 1e-9)


def _glottal_flow(theta: np.ndarray, tp: float = 0.42, tn: float = 0.18) -> np.ndarray:
    """Rosenberg glottal flow pulse over one period (theta in 0..1)."""
    g = np.zeros_like(theta)
    a = theta < tp
    g[a] = 0.5 * (1 - np.cos(np.pi * theta[a] / tp))
    b = (theta >= tp) & (theta < tp + tn)
    g[b] = np.cos(0.5 * np.pi * (theta[b] - tp) / tn)
    return g


def _source_filter(f0: np.ndarray, amp: np.ndarray, breath: np.ndarray, formants: np.ndarray,
                   bands: np.ndarray, nasal: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Glottal pulses (jitter, shimmer, pulsed aspiration) through a time-varying cascade formant filter
    applied in the STFT domain. f0/amp/breath per sample; formants/bands/nasal per 128-sample frame."""
    n = len(f0)
    nfft, hop = 1024, 128
    jitter = 1 + 0.006 * _lp_noise(n, 60, rng)
    shimmer = 1 + 0.05 * _lp_noise(n, 60, rng)
    theta = (np.cumsum(f0 * jitter) / SR + rng.uniform()) % 1.0
    g = _glottal_flow(theta)
    excitation = np.diff(g, prepend=g[0]) * SR / np.maximum(f0, 50) / 40.0
    excitation = (excitation + breath * rng.standard_normal(n) * g * 0.6) * amp * shimmer
    win = np.hanning(nfft)
    pad = np.pad(excitation, (nfft // 2, nfft // 2 + hop))
    n_fr = 1 + (len(pad) - nfft) // hop
    spec = np.fft.rfft(np.lib.stride_tricks.sliding_window_view(pad, nfft)[::hop][:n_fr] * win, axis=1)
    freqs = np.fft.rfftfreq(nfft, 1 / SR)
    idx = np.minimum(np.arange(n_fr), len(formants) - 1)
    fi, bi, ni = formants[idx][:, None, :], bands[idx][:, None, :], nasal[idx][:, None]
    f = freqs[None, :, None]
    h = np.prod(fi ** 2 / np.sqrt((fi ** 2 - f ** 2) ** 2 + (bi * f) ** 2), axis=2)
    murmur = 250.0 ** 2 / np.sqrt((250.0 ** 2 - freqs[None] ** 2) ** 2 + (80.0 * freqs[None]) ** 2)
    h = h * (1 - 0.85 * ni * (freqs[None] > 450)) + ni * 3 * murmur
    frames = np.fft.irfft(spec * h, nfft, axis=1) * win
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    w2 = win ** 2
    for i in range(n_fr):
        out[i * hop:i * hop + nfft] += frames[i]
        norm[i * hop:i * hop + nfft] += w2
    return (out / np.maximum(norm, 1e-3))[nfft // 2:nfft // 2 + n]


def render_voice(notes: list[SungNote], n_samples: int, female: bool, tuning: float,
                 rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Voice (mono float64 at SR, ``n_samples`` long) + true f0 in MIDI on the 10 ms frame grid
    (NaN = unvoiced) + voiced mask."""
    duration = n_samples / SR
    n_ctl = int(duration * CR) + 1
    t = np.arange(n_ctl) / CR
    cents = np.full(n_ctl, np.nan)
    amp = np.zeros(n_ctl)
    breath = np.full(n_ctl, 0.08)
    formants = np.zeros((n_ctl, 5))
    bands = np.zeros((n_ctl, 5))
    nasal = np.zeros(n_ctl)
    scale = FEMALE if female else np.ones(5)
    drift = lfilter([0.002], [1, -0.998], np.cumsum(rng.normal(0, 1, n_ctl)))
    drift = 6.0 * (drift - drift.mean()) / (np.abs(drift - drift.mean()).max() + 1e-9)
    cons_events: list[tuple[float, str, bool]] = []  # (center, consonant, at phrase start)
    for i, n in enumerate(notes):
        nxt = notes[i + 1] if i + 1 < len(notes) else None
        legato = nxt is not None and nxt.trans in ("slide", "dip")
        target = 100.0 * n.midi + tuning + n.err
        a, b = int(n.onset * CR), min(n_ctl, int(n.offset * CR) + (0 if legato else 80))
        seg_t = t[a:b] - n.onset
        c = np.full(b - a, target) + drift[a:b]
        if n.scoop:
            c -= n.scoop * (1 - _smoothstep(seg_t / n.scoop_time))
        if n.vib_depth:
            depth = n.vib_depth * (1 + 0.15 * _lp_noise(b - a, 2.0, rng, CR))
            rate = n.vib_rate * (1 + 0.04 * _lp_noise(b - a, 1.0, rng, CR))
            vib_phase = 2 * np.pi * np.cumsum(rate) / CR + rng.uniform(0, 6.28)
            c += depth * _smoothstep((seg_t - n.vib_delay) / 0.15) * np.sin(vib_phase)
        cents[a:b] = c
        if i > 0 and n.trans in ("slide", "dip") and notes[i - 1].midi != n.midi:
            p = notes[i - 1]
            width = n.trans_len if n.trans == "slide" else 0.03
            ga, gb = int((n.onset - width / 2) * CR), int((n.onset + width / 2) * CR)
            w = _smoothstep((t[ga:gb] - (n.onset - width / 2)) / width)
            prev_c = 100.0 * p.midi + tuning + p.err
            cents[ga:gb] = prev_c + (target - prev_c) * w + drift[ga:gb]
        # amplitude
        a0, b0 = int(n.onset * CR), min(n_ctl, int(n.offset * CR))
        env = n.level * (1.0 - 0.12 * np.clip((t[a0:b0] - n.onset) / max(1e-3, n.offset - n.onset), 0, 1))
        if n.trans in ("rest", "consonant"):
            att = min(len(env), int((0.06 if n.cons == "h" else 0.025) * CR))
            env[:att] *= _smoothstep(np.arange(att) / max(1, att))
        amp[a0:b0] = env
        if not legato:
            rel = int((0.015 if (nxt is not None and nxt.trans == "consonant") else 0.05) * CR)
            r1 = min(n_ctl, b0 + rel)
            amp[b0:r1] = env[-1] if len(env) else n.level
            amp[b0:r1] *= 1 - _smoothstep(np.arange(r1 - b0) / max(1, rel))
            breath[max(0, b0 - 60):r1] = 0.2
        fv, bv = VOWELS[n.vowel]
        formants[a0:b0 + 80] = np.array(fv) * scale
        bands[a0:b0 + 80] = np.array(bv)
        if n.cons == "h":
            breath[a0:a0 + 70] = 0.5
        if n.cons in VOICED_CONS:
            cons_events.append((n.onset, n.cons, n.trans == "rest"))
            if n.trans == "dip":
                w = n.trans_len
                da, db_ = int((n.onset - w / 2) * CR), int((n.onset + w / 2) * CR)
                x = (t[da:db_] - (n.onset - w / 2)) / w
                amp[da:db_] *= 1 - (1 - 10 ** (-n.dip_db / 20)) * np.sin(np.pi * x) ** 2
            else:  # voiced consonant starting a phrase: softer murmur before the vowel
                amp[a0:a0 + 60] *= np.linspace(0.35, 1.0, len(amp[a0:a0 + 60]))
    # vowels: fill the gaps and smooth the changes (40 ms)
    idx = np.arange(n_ctl)
    good = formants[:, 0] > 0
    k = int(0.04 * CR)
    for j in range(5):
        if good.any():
            formants[:, j] = np.interp(idx, idx[good], formants[good, j])
            bands[:, j] = np.interp(idx, idx[good], bands[good, j])
            formants[:, j] = np.convolve(np.pad(formants[:, j], (k // 2, k - k // 2 - 1), mode="edge"),
                                         np.ones(k) / k, "valid")
    # voiced consonants: formants move to the consonant's locus and back (and nasal murmur for m / n)
    for center, cons, phrase_start in cons_events:
        locus, nas = VOICED_CONS[cons]
        lo_t, hi_t = (center, center + 0.07) if phrase_start else (center - 0.045, center + 0.045)
        ca, cb = max(0, int(lo_t * CR)), min(n_ctl, int(hi_t * CR))
        x = (t[ca:cb] - lo_t) / (hi_t - lo_t)
        w = (1 - _smoothstep(x)) if phrase_start else np.sin(np.pi * x) ** 2
        formants[ca:cb] = formants[ca:cb] * (1 - w[:, None]) + (np.array(locus) * scale)[None] * w[:, None]
        nasal[ca:cb] = np.maximum(nasal[ca:cb], nas * w)
    amp = np.convolve(amp, np.ones(10) / 10, mode="same")  # no amplitude steps between legato notes
    voiced_ctl = (amp > 1e-4) & np.isfinite(cents)
    cents = np.where(voiced_ctl, cents, np.nan)

    out = np.zeros(n_samples + SR)
    edges = np.flatnonzero(np.diff(np.r_[0, voiced_ctl.astype(np.int8), 0]))
    for ra, rb in zip(edges[::2], edges[1::2]):
        sa, sb = int(ra * SR / CR), int(rb * SR / CR)
        ts = np.arange(sa, sb) / SR
        tc = t[ra:rb]
        f0 = np.interp(ts, tc, 440.0 * 2 ** ((cents[ra:rb] / 100.0 - 69) / 12))
        fr_t = (sa + np.arange((sb - sa) // 128 + 2) * 128) / SR
        fr_i = np.clip(np.round(fr_t * CR).astype(int), 0, n_ctl - 1)
        out[sa:sb] += _source_filter(f0, np.interp(ts, tc, amp[ra:rb]), np.interp(ts, tc, breath[ra:rb]),
                                     formants[fr_i], bands[fr_i], nasal[fr_i], rng)
    rms_voice = np.sqrt(np.mean(out[out != 0] ** 2)) if np.any(out) else 1.0
    for i, n in enumerate(notes):  # unvoiced consonants and breaths
        if n.cons in UNVOICED_CONS:
            band, _, lvl = UNVOICED_CONS[n.cons]
            ca, cb = int((n.onset - n.trans_len) * SR), int((n.onset + 0.01) * SR)
            sos = butter(4, [band[0], min(band[1], SR / 2 - 100)], btype="band", fs=SR, output="sos")
            burst = sosfilt(sos, rng.standard_normal(cb - ca))
            pos = np.arange(cb - ca)
            env = np.minimum(1, np.minimum(pos / (0.005 * SR), (cb - ca - pos) / (0.01 * SR)))
            if n.cons in ("t", "k", "p"):  # plosive: closure (silence), then a short burst
                env *= pos > 0.4 * (cb - ca)
            out[ca:cb] += burst * env / (np.sqrt(np.mean(burst ** 2)) + 1e-9) * rms_voice * lvl * n.level
        if n.trans == "rest" and i > 0:
            ba, bb = int((n.onset - 0.32) * SR), int((n.onset - 0.08) * SR)
            if ba > 0 and bb > ba:
                br = sosfilt(butter(2, [300, 2500], btype="band", fs=SR, output="sos"), rng.standard_normal(bb - ba))
                env = np.sin(np.pi * np.arange(bb - ba) / (bb - ba)) ** 2
                out[ba:bb] += br * env / (np.sqrt(np.mean(br ** 2)) + 1e-9) * rms_voice * 0.05
    ir_n = int(0.6 * SR)  # a little room
    ir = rng.standard_normal(ir_n) * np.exp(-np.arange(ir_n) / (0.12 * SR))
    ir /= np.sqrt(np.sum(ir ** 2))
    out = (out + 0.16 * fftconvolve(out, ir)[: len(out)])[:n_samples]
    # truth on the 10 ms grid
    fc = np.clip(np.round(np.arange(int(duration / HOP) + 1) * HOP * CR).astype(int), 0, n_ctl - 1)
    f0_true = np.where(voiced_ctl[fc] & (amp[fc] > 0.1 * np.max(amp)), cents[fc] / 100.0, np.nan)
    return out, f0_true, np.isfinite(f0_true)


def make_song(spec: synth.SongSpec, idx: int, out_dir: Path) -> Path:
    import soundfile as sf

    kind, (lo, hi), tuning, snr = VOICES[idx % len(VOICES)]
    rng = np.random.default_rng(1000 + idx)
    acc, truth = synth.render(dataclasses.replace(spec, melody=False))
    duration = len(acc) / SR
    notes = compose(spec, rng, lo, hi)
    voice, f0_true, _ = render_voice(notes, len(acc), kind == "female", tuning, rng)
    on = np.abs(voice) > 0
    mask = np.zeros(len(acc), dtype=bool)
    for n in notes:
        mask[int(n.onset * SR):int(n.offset * SR)] = True
    v_rms = np.sqrt(np.mean(voice[mask] ** 2))
    a_rms = np.sqrt(np.mean(acc[mask] ** 2)) + 1e-9
    voice *= a_rms / v_rms * 10 ** (snr / 20)
    mix = acc + voice
    mix = 0.9 * mix / (np.max(np.abs(mix)) + 1e-9)
    name = f"vox_{spec.name}"
    wav = out_dir / f"{name}.wav"
    sf.write(str(wav), mix.astype(np.float32), SR, subtype="PCM_16")
    meta = {
        "name": name, "voice": kind, "tuningCents": tuning, "voiceDb": snr, "duration": duration,
        "notes": [[round(n.onset, 4), round(n.offset, 4), n.midi, n.trans] for n in notes],
        "f0": [None if not np.isfinite(v) else round(float(v), 3) for v in f0_true],
        "voiceActive": bool(on.any()),
    }
    (out_dir / f"{name}.json").write_text(json.dumps(meta))
    return wav


# --------------------------------------------------------------------------- metrics


def _hz(m) -> np.ndarray:
    return 440.0 * 2 ** ((np.asarray(m, dtype=float) - 69) / 12)


def note_metrics(ref: list, est: list) -> dict:
    import mir_eval

    ref_i = np.array([[r[0], r[1]] for r in ref], dtype=float).reshape(-1, 2)
    ref_p = _hz([r[2] for r in ref])
    est_i = np.array([[e[0], e[1]] for e in est], dtype=float).reshape(-1, 2)
    est_p = _hz([e[2] for e in est])
    out = {"ref": len(ref), "est": len(est)}
    if len(est) == 0:
        return {**out, "onP": 0.0, "onR": 0.0, "onF": 0.0, "onoffF": 0.0, "pitch": 0.0, "onMatch": 0, "pitchMatch": 0}
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        ref_i, ref_p, est_i, est_p, onset_tolerance=0.05, pitch_tolerance=50.0, offset_ratio=None)
    _, _, f2, _ = mir_eval.transcription.precision_recall_f1_overlap(
        ref_i, ref_p, est_i, est_p, onset_tolerance=0.05, pitch_tolerance=50.0, offset_ratio=0.2,
        offset_min_tolerance=0.05)
    matched = mir_eval.transcription.match_notes(ref_i, ref_p, est_i, est_p, onset_tolerance=0.05,
                                                 pitch_tolerance=1e6, offset_ratio=None)
    good = sum(abs(1200 * np.log2(est_p[j] / ref_p[i])) <= 50 for i, j in matched)
    tp = int(round(r * len(ref)))
    return {**out, "onP": p, "onR": r, "onF": f, "onoffF": f2, "pitch": good / max(1, len(matched)),
            "onMatch": len(matched), "pitchMatch": int(good), "tp": tp,
            "onsetErr": float(np.median([est_i[j, 0] - ref_i[i, 0] for i, j in matched])) if matched else 0.0}


def frame_metrics(f0_true: np.ndarray, est_midi: np.ndarray, est_voiced: np.ndarray) -> dict:
    n = min(len(f0_true), len(est_midi))
    ref_v = np.isfinite(f0_true[:n])
    est_v = est_voiced[:n] & np.isfinite(est_midi[:n])
    both = ref_v & est_v
    rpa = float(np.mean(np.abs(est_midi[:n][both] - f0_true[:n][both]) <= 0.5)) if both.any() else 0.0
    vr = float(both.sum() / max(1, ref_v.sum()))
    vfa = float((est_v & ~ref_v).sum() / max(1, (~ref_v).sum()))
    return {"RPA": rpa, "VR": vr, "VFA": vfa}


# --------------------------------------------------------------------------- runs


def evaluate_synthetic(args) -> None:
    from app.vocals import pipeline

    out_dir = args.out or Path(tempfile.mkdtemp(prefix="vocals-eval-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    cache = args.cache
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    rows = []
    timings = []
    try:
        for idx, spec in enumerate(synth.SONGS):
            name = f"vox_{spec.name}"
            if args.only and name not in args.only and spec.name not in args.only:
                continue
            wav = out_dir / f"{name}.wav"
            if not wav.exists():
                make_song(spec, idx, out_dir)
            truth = json.loads((out_dir / f"{name}.json").read_text())
            stems = out_dir / f"{name}.stems"
            opts = {k: v for k, v in (("device", args.device), ("crepe", args.crepe)) if v}
            started = time.perf_counter()
            tr = pipeline.run(wav, stems, options=opts)
            wall = time.perf_counter() - started
            timings.append((truth["duration"], wall, tr.timings))
            if cache:
                np.savez_compressed(cache / f"{name}.npz", midi=tr.track.midi, per=tr.track.periodicity,
                                    energy=tr.energy_db, onset=tr.onset)
                shutil.copy(out_dir / f"{name}.json", cache / f"{name}.json")
            rows.append(_score(name, truth, tr.result["notes"], tr.seg, tr.result["tuningCents"]))
            _print_row(rows[-1])
    finally:
        if not args.out and not args.keep:
            shutil.rmtree(out_dir, ignore_errors=True)
    _print_total(rows)
    total_audio = sum(t[0] for t in timings)
    total_wall = sum(t[1] for t in timings)
    parts: dict[str, float] = {}
    for _, _, tm in timings:
        for k, v in tm.items():
            parts[k] = parts.get(k, 0.0) + v
    speed = total_wall / max(1e-9, total_audio)
    print(f"\ntime: {total_wall:.1f}s for {total_audio:.0f}s of audio ({speed:.3f}x realtime); "
          + ", ".join(f"{k} {v:.1f}s" for k, v in parts.items()))


def _score(name: str, truth: dict, est_notes: list, seg, tuning_est: float) -> dict:
    ref = [r[:3] for r in truth["notes"]]
    nm = note_metrics(ref, est_notes)
    f0 = np.array([np.nan if v is None else v for v in truth["f0"]])
    fm = frame_metrics(f0, seg.smooth_midi, seg.voiced)
    return {"name": name, **nm, **fm, "tuning": tuning_est, "tuningRef": truth["tuningCents"]}


def _print_row(r: dict) -> None:
    print(f"{r['name']:28s} ref {r['ref']:3d} est {r['est']:3d}  onF {r['onF']:.3f} (P {r['onP']:.3f} R {r['onR']:.3f})"
          f"  onoffF {r['onoffF']:.3f}  pitch {r['pitch']:.3f}  RPA {r['RPA']:.3f} VR {r['VR']:.3f} VFA {r['VFA']:.3f}"
          f"  tuning {r['tuning']:+.0f}/{r['tuningRef']:+.0f}c  onset err {1000 * r['onsetErr']:+.0f}ms", flush=True)


def _print_total(rows: list[dict]) -> None:
    if not rows:
        return
    ref = sum(r["ref"] for r in rows)
    est = sum(r["est"] for r in rows)
    tp = sum(r.get("tp", 0) for r in rows)
    p, rc = tp / max(1, est), tp / max(1, ref)
    f = 2 * p * rc / max(1e-9, p + rc)
    mean = {k: float(np.mean([r[k] for r in rows])) for k in ("onF", "onoffF", "pitch", "RPA", "VR", "VFA")}
    pm = sum(r["pitchMatch"] for r in rows) / max(1, sum(r["onMatch"] for r in rows))
    print(f"{'TOTAL (micro)':28s} ref {ref:3d} est {est:3d}  onF {f:.3f} (P {p:.3f} R {rc:.3f})  pitch {pm:.3f}")
    print(f"{'MEAN (per song)':28s}" + "  ".join(f"{k} {v:.3f}" for k, v in mean.items()))


def resegment(args) -> None:
    rows = []
    params = seg_mod.DEFAULT
    if args.params:
        params = dataclasses.replace(params, **json.loads(args.params))
    for npz in sorted(args.resegment.glob("*.npz")):
        if args.only and npz.stem not in args.only:
            continue
        d = np.load(npz)
        truth = json.loads(npz.with_suffix(".json").read_text())
        seg = seg_mod.segment(d["midi"], d["per"], d["energy"], d["onset"], params)
        rows.append(_score(npz.stem, truth, [list(n) for n in seg.notes], seg, seg.tuning_cents))
        _print_row(rows[-1])
    _print_total(rows)


# --------------------------------------------------------------------------- real recordings


def _png(path: Path, rgb: np.ndarray) -> None:
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].astype(np.uint8).tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def piano_roll(path: Path, result: dict, t0: float, t1: float, px_per_s: int = 40, px_per_semi: int = 6) -> None:
    rng = result.get("range") or {"low": 48, "high": 72}
    lo, hi = rng["low"] - 3, rng["high"] + 3
    w, h = int((t1 - t0) * px_per_s), (hi - lo + 1) * px_per_semi
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    for m in range(lo, hi + 1):  # C lines
        if m % 12 == 0:
            img[h - 1 - (m - lo) * px_per_semi - px_per_semi // 2, :, :] = 200
    for s in range(int(t0), int(t1) + 1):
        x = int((s - t0) * px_per_s)
        if 0 <= x < w:
            img[:, x, :] = 235
    for start, end, midi, _ in result["notes"]:
        if end < t0 or start > t1:
            continue
        xa, xb = max(0, int((start - t0) * px_per_s)), min(w, int((end - t0) * px_per_s) + 1)
        y = h - 1 - (midi - lo) * px_per_semi
        img[max(0, y - px_per_semi + 1):y + 1, xa:xb] = (60, 120, 230)
    c = result.get("contour")
    if c:
        tuning = result.get("tuningCents", 0.0) / 100.0
        for i, m in enumerate(c["midi"]):
            tt = c["start"] + i * c["hop"]
            if m is None or not (t0 <= tt < t1):
                continue
            x = int((tt - t0) * px_per_s)
            y = int(round(h - 1 - (m - tuning - lo) * px_per_semi - px_per_semi / 2))
            if 0 <= y < h:
                img[y, x] = (220, 40, 40)
    _png(path, img)


def summarize_real(args) -> None:
    from app.engine import analyze
    from app.vocals import pipeline

    path = args.real
    stems = Path(tempfile.mkdtemp(prefix="vocals-real-"))
    try:
        opts = {k: v for k, v in (("device", args.device), ("crepe", args.crepe)) if v}
        tr = pipeline.run(path, stems, options=opts)
        res = tr.result
        if args.cache:
            args.cache.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(args.cache / f"{path.stem}.npz", midi=tr.track.midi, per=tr.track.periodicity,
                                energy=tr.energy_db, onset=tr.onset)
        sizes = {p.name: p.stat().st_size for p in stems.iterdir()}
    finally:
        shutil.rmtree(stems, ignore_errors=True)
    notes = res["notes"]
    dur = len(tr.energy_db) * HOP
    print(f"file: {path.name}  duration {dur:.1f}s  device {tr.device}  engine {res['engine']}")
    print("timings: " + ", ".join(f"{k} {v:.1f}s" for k, v in tr.timings.items())
          + f"  ({tr.timings['total'] / dur:.3f}x realtime)")
    print("stems: " + ", ".join(f"{k} {v / 1e6:.1f} MB" for k, v in sizes.items()))
    print(f"notes {len(notes)} ({60 * len(notes) / dur:.0f}/min), tuning {res['tuningCents']:+.1f} cents, "
          f"range {res['range']}")
    if notes:
        lengths = np.array([n[1] - n[0] for n in notes])
        print(f"note length: median {np.median(lengths) * 1000:.0f} ms, 10-90% {np.percentile(lengths, 10) * 1000:.0f}"
              f"-{np.percentile(lengths, 90) * 1000:.0f} ms; voiced frames {tr.seg.voiced.mean():.1%}")
        hist = np.zeros(12)
        for s, e, m, _ in notes:
            hist[m % 12] += e - s
        names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
        order = np.argsort(-hist)
        print("pitch classes by sung time: " + " ".join(f"{names[i]} {hist[i] / hist.sum():.0%}" for i in order[:8]))
        midis = [n[2] for n in notes]
        print(f"pitch: median {np.median(midis):.0f}, "
              f"5-95% {np.percentile(midis, 5):.0f}-{np.percentile(midis, 95):.0f}")
        steps = np.abs(np.diff(midis))
        print(f"intervals between notes: unison {np.mean(steps == 0):.0%}, "
              f"steps (1-2) {np.mean((steps >= 1) & (steps <= 2)):.0%}, "
              f"3-5 {np.mean((steps >= 3) & (steps <= 5)):.0%}, >5 {np.mean(steps > 5):.0%}, "
              f">12 {np.mean(steps > 12):.0%}")
    if args.key:
        chords = analyze(str(path))
        print(f"chord engine key: {chords['key']['name']} (confidence {chords['key']['confidence']:.2f})")
    if args.png:
        t0 = args.png_start
        piano_roll(args.png, res, t0, min(dur, t0 + args.png_seconds))
        print(f"piano roll: {args.png}")
    if args.json:
        args.json.write_text(json.dumps(res))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, help="keep the rendered songs + stems here (reused when present)")
    ap.add_argument("--keep", action="store_true", help="do not delete the temporary directory")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--device", choices=["cpu", "mps"])
    ap.add_argument("--crepe", choices=["tiny", "full"])
    ap.add_argument("--cache", type=Path, help="save frame features (for --resegment)")
    ap.add_argument("--resegment", type=Path, help="re-run only the segmentation on cached features")
    ap.add_argument("--params", help='SegParams overrides as JSON, e.g. {"dip_db": 6}')
    ap.add_argument("--real", type=Path, help="summarize a real recording instead")
    ap.add_argument("--key", action="store_true", help="(--real) also run the chord engine for the key")
    ap.add_argument("--png", type=Path, help="(--real) write a piano roll (notes blue, contour red)")
    ap.add_argument("--png-start", type=float, default=0.0)
    ap.add_argument("--png-seconds", type=float, default=60.0)
    ap.add_argument("--json", type=Path, help="(--real) write the VocalNotes JSON")
    args = ap.parse_args()
    if args.real:
        summarize_real(args)
    elif args.resegment:
        resegment(args)
    else:
        evaluate_synthetic(args)


if __name__ == "__main__":
    main()
