// Wind voices — the sopilka and the concert flute — for the chord sound and the play-along. Both are
// air-jet instruments: a jet of breath across an edge drives the air column, so the tone is a
// harmonic spectrum (no inharmonicity, no decay while the player blows) with breath noise under it.
// What each model holds (WIND_MODELS, with its sources) and what this voice reproduces:
//  - the measured harmonic spectrum, interpolated in dB between reference notes: rich low down,
//    nearly a sine at the top;
//  - the attack: the fundamental builds up over a few tens of ms after the tongue releases the
//    air (on the flute a fixed number of periods: longer low down), the upper harmonics a little
//    later; a short burst of edge noise (the "chiff") and a pitch that starts a few cents flat while
//    the breath pressure rises;
//  - the breath: band-limited noise under the tone, following its envelope, pulsing with its period;
//  - vibrato (delayed, rising in): a pitch swing with the amplitude and the brightness moving with
//    it (a breath vibrato pushes the upper harmonics more than the fundamental); a slow wander of
//    pitch and level, as no breath is perfectly steady.
// The note is rendered once per (instrument, key, sample rate): the attack, then exactly one loop
// of the steady tone — every harmonic, the vibrato, the wander and the breath noise complete whole
// cycles within it, so the engine repeats [WIND_LOOP_START, end) seamlessly for as long as the
// note is held and fades it out when the player stops blowing.

import type { WindInstrument } from '../wind/types'
import { clamp, filterInPlace, lowpassBiquad, midiToFreq, mulberry32 } from './dsp'

export type { WindInstrument }

/** Harmonic levels (dB re the strongest) measured on one note, 1st harmonic first. */
export interface WindSpectrum {
  midi: number
  db: readonly number[]
}

export interface WindModel {
  /** measured spectra, ascending in pitch (interpolated in dB between them, held outside) */
  spectra: readonly WindSpectrum[]
  /** the fundamental reaches its level (s, ~95%): at least `attack`, and `attackCycles` periods of the note */
  attack: number
  attackCycles: number
  /** the upper harmonics start this long after the fundamental (s) and build up this much slower (×) */
  upperLag: number
  upperSlow: number
  /** the pitch starts this many cents flat and settles with this time constant (s) */
  scoopCents: number
  scoopTime: number
  /** breath noise: level re the tone's RMS (dB); a band around `noiseCentre` × the fundamental (clamped to [noiseMin, noiseMax] Hz), `noiseWidth` octaves wide */
  noiseDb: number
  noiseCentre: number
  noiseMin: number
  noiseMax: number
  noiseWidth: number
  /** the breath comes in pulses locked to the period: the noise's level swings ± this fraction with the waveform */
  noiseSync: number
  /** the chiff: a burst of edge noise at the start (dB re the tone's RMS), its decay (s) and band (Hz) */
  chiffDb: number
  chiffDecay: number
  chiffLo: number
  chiffHi: number
  /** vibrato: rate (Hz), pitch depth (± cents), amplitude depth (± fraction of the fundamental), how much more the upper harmonics move (per harmonic) */
  vibratoRate: number
  vibratoCents: number
  vibratoAm: number
  vibratoBright: number
  /** vibrato starts this long into the note and takes this long to reach full depth (s) */
  vibratoDelay: number
  vibratoRise: number
  /** slow wander of pitch (± cents) and level (± dB) */
  wanderCents: number
  wanderDb: number
  /** louder up the range: dB per semitone */
  levelSlope: number
  /** the note's reference pitch for the level slope */
  levelMidi: number
}

/** Harmonics are kept below this (Hz) and above this level (dB). */
const HARMONIC_LIMIT = 10000
const FLOOR_DB = -60
/** Steady RMS of a rendered note at levelMidi (before the engine's level). */
export const WIND_RMS = 0.12
/** The attack is over and the vibrato at full depth by here (s): the steady loop starts. */
export const WIND_LOOP_START = 0.75
/** Length of the steady loop (s, about: whole periods of the note in whole samples); the vibrato completes whole cycles in it. */
export const WIND_LOOP = 1.6
/** The breath noise's own crossfade at its loop seam (s). */
const NOISE_SEAM = 0.12
/** Knots of the slow wander per loop (cosine-interpolated, periodic). */
const WANDER_KNOTS = 4
/** Samples per control step (envelopes, modulation), interpolated linearly in between. */
const BLOCK = 16
const SINE = 4096
const SINE_TABLE = (() => {
  const t = new Float32Array(SINE + 1)
  for (let i = 0; i <= SINE; i++) t[i] = Math.sin((2 * Math.PI * i) / SINE)
  return t
})()

export interface WindParams {
  instrument: WindInstrument
  sampleRate: number
  midi: number
  seed: number
}

const SEED: Record<WindInstrument, number> = { sopilka: 52361, flute: 86243 }

export function windParams(instrument: WindInstrument, midi: number, sampleRate: number): WindParams {
  return { instrument, sampleRate, midi, seed: SEED[instrument] + midi * 271 }
}

/** Harmonic levels (dB re the strongest) for `midi`, interpolated between the measured notes. */
export function windSpectrum(model: WindModel, midi: number): number[] {
  const s = model.spectra
  if (s.length === 1) return [...s[0].db]
  const m = clamp(midi, s[0].midi, s[s.length - 1].midi)
  let i = 0
  while (i < s.length - 2 && s[i + 1].midi <= m) i++
  const a = s[i]
  const b = s[i + 1]
  const t = clamp((m - a.midi) / (b.midi - a.midi), 0, 1)
  return Array.from({ length: Math.max(a.db.length, b.db.length) }, (_, k) => (1 - t) * (a.db[k] ?? FLOOR_DB) + t * (b.db[k] ?? FLOOR_DB))
}

/**
 * The steady loop: about WIND_LOOP seconds holding a whole number of periods (`cycles`), its length
 * in whole samples, and the frequency that makes it exact (a few hundredths of a cent off the key).
 */
export function windLoop(midi: number, sampleRate: number): { length: number; start: number; freq: number; cycles: number } {
  const f = midiToFreq(midi)
  const cycles = Math.max(1, Math.round(f * WIND_LOOP))
  const length = Math.round((cycles * sampleRate) / f)
  return { length, start: Math.round(WIND_LOOP_START * sampleRate), freq: (cycles * sampleRate) / length, cycles }
}

/** Build-up of a tone over t (s) with ~95% reached at `time`: smooth from 0, exactly 1 from 1.6 × time. */
export function windOnset(t: number, time: number): number {
  if (t <= 0) return 0
  const u = t / (time * 1.6)
  if (u >= 1) return 1
  // raised cosine in the first half (no click), then an exponential-like approach
  const s = 1 - Math.pow(1 - u, 3)
  return s * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, u * 2)))
}

/** Smooth periodic curve in [−1, 1] with zero mean: `knots` cosine-interpolated values over `period` samples. */
function periodicWander(rand: () => number, knots: number, period: number): (i: number) => number {
  const v = Array.from({ length: knots }, () => rand() * 2 - 1)
  const mean = v.reduce((a, b) => a + b, 0) / knots
  for (let k = 0; k < knots; k++) v[k] -= mean
  return (i: number) => {
    const x = ((((i % period) + period) % period) / period) * knots
    const k = Math.floor(x)
    const f = 0.5 - 0.5 * Math.cos(Math.PI * (x - k))
    return v[k % knots] * (1 - f) + v[(k + 1) % knots] * f
  }
}

/** White noise band-limited to [lo, hi] Hz, unit RMS. */
function bandNoise(length: number, sampleRate: number, lo: number, hi: number, rand: () => number): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1
  filterInPlace(out, lowpassBiquad(sampleRate, hi))
  filterInPlace(out, lowpassBiquad(sampleRate, hi))
  const a = Math.exp((-2 * Math.PI * lo) / sampleRate)
  let x1 = 0
  let y1 = 0
  let sum = 0
  for (let i = 0; i < length; i++) {
    const y = a * (y1 + out[i] - x1)
    x1 = out[i]
    y1 = y
    out[i] = y
    sum += y * y
  }
  const rms = Math.sqrt(sum / Math.max(1, length))
  if (rms > 0) for (let i = 0; i < length; i++) out[i] /= rms
  return out
}

/** Breath noise exactly `period` samples long that repeats without a seam (its tail crossfaded, equal power, into its head). */
function loopedNoise(period: number, sampleRate: number, lo: number, hi: number, rand: () => number): Float32Array {
  const seam = Math.min(Math.round(NOISE_SEAM * sampleRate), period >> 1)
  const raw = bandNoise(period + seam, sampleRate, lo, hi, rand)
  const out = raw.slice(0, period)
  for (let i = 0; i < seam; i++) {
    const t = ((i + 0.5) / seam) * (Math.PI / 2)
    out[i] = raw[period + i] * Math.cos(t) + raw[i] * Math.sin(t)
  }
  return out
}

/**
 * Renders one note of a wind instrument: mono, the attack then one steady loop — play it from 0 and
 * loop over [loop.start, length) (windLoop) for as long as the note is held.
 */
export function renderWind(p: WindParams, model: WindModel = WIND_MODELS[p.instrument]): Float32Array {
  const fs = p.sampleRate
  const loop = windLoop(p.midi, fs)
  const length = loop.start + loop.length
  const out = new Float32Array(length)
  const rand = mulberry32(p.seed)
  const levels = windSpectrum(model, p.midi)
  const limit = Math.min(HARMONIC_LIMIT, fs * 0.45)

  // harmonics that sound, their amplitudes and starting phases (as fractions of a cycle)
  const amps: number[] = []
  const phases: number[] = []
  let power = 0
  for (let k = 1; k <= levels.length; k++) {
    const phase = rand()
    if (k * loop.freq >= limit || levels[k - 1] <= FLOOR_DB) break
    const a = Math.pow(10, levels[k - 1] / 20)
    amps.push(a)
    phases.push(phase)
    power += (a * a) / 2
  }
  const toneRms = Math.sqrt(power)
  const scale = toneRms > 0 ? (WIND_RMS * Math.pow(10, (model.levelSlope * (p.midi - model.levelMidi)) / 20)) / toneRms : 0
  const noteRms = scale * toneRms
  const attack = Math.max(model.attack, model.attackCycles / loop.freq)

  // vibrato: whole cycles in the loop
  const loopSeconds = loop.length / fs
  const vibRate = Math.max(1, Math.round(model.vibratoRate * loopSeconds)) / loopSeconds
  const pitchWander = periodicWander(rand, WANDER_KNOTS, loop.length)
  const levelWander = periodicWander(rand, WANDER_KNOTS, loop.length)
  const vibratoAt = (t: number) => {
    const env = clamp((t - model.vibratoDelay) / Math.max(1e-3, model.vibratoRise), 0, 1)
    return env * env * (3 - 2 * env) * Math.sin(2 * Math.PI * vibRate * t)
  }

  // phase increment per sample (cycles of the fundamental): the loop's sum is exactly `cycles`
  const inc = new Float64Array(length)
  const base = loop.freq / fs
  for (let i = 0; i < length; i++) {
    const t = i / fs
    const cents = model.vibratoCents * vibratoAt(t) + model.wanderCents * pitchWander(i) - model.scoopCents * Math.exp(-t / model.scoopTime)
    inc[i] = base * Math.pow(2, cents / 1200)
  }
  let sum = 0
  for (let i = loop.start; i < length; i++) sum += inc[i]
  const fix = loop.cycles / sum
  for (let i = loop.start; i < length; i++) inc[i] *= fix

  const centre = clamp(model.noiseCentre * loop.freq, model.noiseMin, model.noiseMax)
  const half = Math.pow(2, model.noiseWidth / 2)
  const noise = loopedNoise(loop.length, fs, centre / half, Math.min(centre * half, fs * 0.45), rand)
  const chiffLength = Math.min(loop.start, Math.round(model.chiffDecay * 8 * fs))
  const chiff = bandNoise(Math.max(1, chiffLength), fs, model.chiffLo, Math.min(model.chiffHi, fs * 0.45), rand)
  const noiseLevel = noteRms * Math.pow(10, model.noiseDb / 20)
  const chiffLevel = noteRms * Math.pow(10, model.chiffDb / 20)

  // per-block gains of every harmonic and of the breath
  const n = amps.length
  const control = (i: number) => {
    const t = i / fs
    const vib = vibratoAt(t)
    const level = scale * Math.pow(10, (model.wanderDb * levelWander(i)) / 20)
    const g = new Float64Array(n + 1)
    const fund = windOnset(t, attack)
    const upper = windOnset(t - model.upperLag, attack * model.upperSlow)
    for (let k = 0; k < n; k++) {
      const am = 1 + Math.min(0.8, model.vibratoAm * (1 + model.vibratoBright * k)) * vib
      g[k] = amps[k] * level * (k === 0 ? fund : upper) * am
    }
    g[n] = noiseLevel * Math.pow(10, (model.wanderDb * levelWander(i)) / 20) * fund * (1 + model.vibratoAm * vib)
    return g
  }

  let phase = 0
  let now = control(0)
  for (let from = 0; from < length; from += BLOCK) {
    const to = Math.min(length, from + BLOCK)
    const next = control(to)
    const span = to - from
    for (let i = from, j = 0; i < to; i++, j++) {
      const f = j / span
      let v = 0
      for (let k = 0; k < n; k++) {
        let x = (k + 1) * phase + phases[k]
        x -= Math.floor(x)
        const pos = x * SINE
        const idx = pos | 0
        const s = SINE_TABLE[idx] + (pos - idx) * (SINE_TABLE[idx + 1] - SINE_TABLE[idx])
        v += (now[k] + (next[k] - now[k]) * f) * s
      }
      const ni = i >= loop.start ? i - loop.start : (((i - loop.start) % loop.length) + loop.length) % loop.length
      let pulse = phase * SINE + SINE / 4
      pulse -= Math.floor(pulse / SINE) * SINE
      v += (now[n] + (next[n] - now[n]) * f) * noise[ni] * (1 + model.noiseSync * SINE_TABLE[pulse | 0])
      if (i < chiffLength) {
        const t = i / fs
        v += chiffLevel * Math.min(1, t / 0.002) * Math.exp(-t / model.chiffDecay) * chiff[i]
      }
      out[i] = v
      phase += inc[i]
      if (phase >= 1) phase -= Math.floor(phase)
    }
    now = next
  }
  return out
}

// ---------- the instruments ----------

/** Sopilka and concert flute: see the sources next to each number. */
export const WIND_MODELS: Record<WindInstrument, WindModel> = {
  // The sopilka is a duct flute like the recorder, warmer and with more overtones ("open, full,
  // slightly diffuse": Tibia on Demenchuk's rounded, long-cut labium). No measured sopilka spectrum
  // is published: the levels blend the preferred treble-recorder tone (harmonics ~4 dB apart, the
  // even ones ~10 dB lower: Ando & Shima 1978) with the tin whistle (~−8 dB per octave, nothing
  // above h5–h6: Timoney et al., DAFx-04); overblown notes ~6 dB poorer in harmonics, the top nearly
  // a sine (UNSW flute acoustics). The attack: a 10–15 ms burst of edge noise (the "chiff") before
  // the harmonics build up, the fundamental in 20–30 ms, the upper harmonics 5–10 ms later, the pitch
  // rising ~15 cents with the breath pressure (flue-pipe transients: Ernoult & Fabre, JASA 2017;
  // Castellengo 1999); tongued "ту". Folk playing ornaments rather than vibrates: a light breath
  // vibrato only on long notes.
  sopilka: {
    spectra: [
      { midi: 72, db: [0, -11, -8, -19, -16, -26, -24, -32] },
      { midi: 83, db: [0, -12, -9, -20, -17, -27, -25, -33] },
      { midi: 84, db: [0, -17, -14, -25, -22, -32, -30] },
      { midi: 95, db: [0, -21, -19, -30, -28, -38] },
    ],
    attack: 0.025,
    attackCycles: 0,
    upperLag: 0.007,
    upperSlow: 1.1,
    scoopCents: 15,
    scoopTime: 0.01,
    noiseDb: -30,
    noiseCentre: 2.5,
    noiseMin: 1500,
    noiseMax: 5000,
    noiseWidth: 1.6,
    noiseSync: 0.3,
    chiffDb: -14,
    chiffDecay: 0.005,
    chiffLo: 1500,
    chiffHi: 8000,
    vibratoRate: 5.2,
    vibratoCents: 5,
    vibratoAm: 0.06,
    vibratoBright: 0.25,
    vibratoDelay: 0.35,
    vibratoRise: 0.35,
    wanderCents: 2,
    wanderDb: 0.3,
    levelSlope: 0.05,
    levelMidi: 79,
  },
  // The concert flute: harmonic levels measured on a modern flute (UNSW Music Acoustics, "Flute
  // acoustics": C4, A4, C5, G5, C6, G6, played mezzo-forte to loud) — in the low register the 2nd
  // and 3rd harmonics as strong as the fundamental, the middle one led by it, the high one nearly a
  // sine (Fletcher, "Acoustical correlates of flute performance technique", JASA 1975). The attack
  // takes a near-constant number of periods (~20–26 staccato, ~50–60 detached: Grobben 1967), so a
  // tongued note speaks in ~30 periods: ~110 ms on C4, ~55 ms on C5. Breath noise ~35–40 dB under
  // the tone, weighted to the highs and pulsing with the period (Nishimura et al. 2001; Chafe 1993),
  // a chiff ~12 dB over it at the start. Vibrato ~5 Hz (4.5–6), ±10 cents, mostly loudness and
  // brightness: per harmonic ±15% (h1) to ±50–70% (h3–h4) from a ±10% swing of the blowing pressure
  // (Fletcher 1975), started straight and brought in after ~200 ms.
  flute: {
    spectra: [
      { midi: 60, db: [0, -3, -4, -10, -12, -20, -24, -25] },
      { midi: 69, db: [0, -2, -7.5, -13.5, -20.5, -29, -27.5, -26] },
      { midi: 72, db: [0, -6.5, -14.5, -20, -24, -23, -33, -37] },
      { midi: 79, db: [0, -16, -18, -30, -33, -40, -41] },
      { midi: 84, db: [0, -25.5, -18.5, -39.5, -32, -41.5, -42.5] },
      { midi: 91, db: [0, -27, -28, -37.5] },
    ],
    attack: 0.03,
    attackCycles: 30,
    upperLag: 0.012,
    upperSlow: 1.3,
    scoopCents: 3,
    scoopTime: 0.03,
    noiseDb: -34,
    noiseCentre: 4,
    noiseMin: 2000,
    noiseMax: 6000,
    noiseWidth: 1.8,
    noiseSync: 0.6,
    chiffDb: -22,
    chiffDecay: 0.012,
    chiffLo: 1200,
    chiffHi: 7000,
    vibratoRate: 5,
    vibratoCents: 10,
    vibratoAm: 0.15,
    vibratoBright: 1.33,
    vibratoDelay: 0.2,
    vibratoRise: 0.3,
    wanderCents: 3,
    wanderDb: 0.3,
    levelSlope: 0.08,
    levelMidi: 72,
  },
}
