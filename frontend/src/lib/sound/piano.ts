// Acoustic grand piano note, rebuilt from recordings of real ones and rendered offline into a
// Float32Array once per (key, touch, hold, sample rate) — the engine caches it. Analysed partial by
// partial on two sample sets:
//  - Salamander Grand Piano v3 (Yamaha C5, Alexander Holm, CC-BY 3.0): every minor third A0–C8, 16
//    velocity layers, two AKG C414 ~12 cm above the strings;
//  - University of Iowa MIS piano samples (Steinway B, Evan Mazunik, 2001): pp / mf / ff.
// What the analysis found, and what this voice reproduces:
//  - the spectrum: each partial's level at a moderate touch, measured every minor third (Salamander,
//    the median of the three layers around MIDI velocity 85), interpolated between them in dB; a
//    softer touch is darker, a harder one brighter and louder (the measured change from layer to
//    layer, per octave band);
//  - string stiffness stretches the partials, f_n = n·f0·√(1 + B·n²): B ≈ 1e-4 in the wound bass,
//    doubling every 8 semitones above C3 (both pianos agree within ~15 %); the tuning is stretched
//    too — the bass a few cents flat, the treble up to ~10 cents sharp at C7;
//  - the double decay: every partial first falls fast (the prompt sound), then slowly (the
//    aftersound, 10–30 dB down), both faster for higher partials and higher keys — one smooth
//    model fitted to ~18 000 level drops of both pianos (0.1–6 s; median error 3 dB);
//  - the unison strings beat: the aftersound is two strings a little off the prompt one, ~0.6 Hz
//    apart around 1 kHz, ~1.5 Hz around 4 kHz (median rates; 8–12 dB deep ripples, as measured);
//  - the hammer's knock: the soundboard's woody thump, measured under the fundamentals (where no
//    partial sounds) — it swells over ~20 ms, falls ~6 dB per doubling of time, is ~10 dB under the
//    tone in the middle and about as loud as the fundamental on the top keys; a little darker in
//    the bass, where the hammer touches the strings longer (1–4 ms);
//  - key up: the dampers stop the strings (upper partials faster; the top keys have none) with
//    the action's soft thud.

import { clamp, midiToFreq, mulberry32 } from './dsp'

/** One measured key: partial levels (dB re its strongest partial), the fundamental first. */
export interface PartialLevels {
  midi: number
  levels: readonly number[]
}

/** Salamander, every minor third A1–D♯7 (partials above 10 kHz or 50 dB under the strongest left out). */
export const PIANO_SPECTRA: readonly PartialLevels[] = [
  { midi: 33, levels: [-17, 0, -1, -11, -7, -16, -13, -31, -23, -18, -14, -18, -18, -19, -23, -28, -25, -20, -21, -14, -21, -27, -34, -32, -33, -26, -32, -27, -24, -29, -36, -33, -41, -35, -31, -29, -25, -31, -38, -40, -47, -41, -43, -37, -40, -37, -48, -40, -39, -56, -49, -51, -47, -52, -48, -51, -54, -36, -45] },
  { midi: 36, levels: [-15, 0, 0, -9, -13, -14, -19, -26, -22, -21, -20, -18, -14, -19, -18, -29, -33, -29, -26, -20, -19, -24, -24, -29, -25, -34, -36, -25, -28, -27, -29, -37, -49, -41, -36, -36, -36, -42, -47, -53, -51, -60, -52, -55, -49, -46, -35, -48] },
  { midi: 39, levels: [-4, 0, -10, -13, -14, -18, -19, -29, -21, -21, -23, -23, -19, -20, -19, -26, -30, -30, -32, -25, -23, -29, -28, -24, -46, -46, -40, -34, -32, -34, -43, -52, -58, -44, -39, -49, -49] },
  { midi: 42, levels: [0, 0, -7, -16, -14, -16, -13, -31, -27, -19, -18, -19, -19, -20, -31, -31, -35, -33, -35, -31, -34, -29, -34, -44, -50, -52, -49, -44, -45, -48, -55, -50, -46, -45] },
  { midi: 45, levels: [0, -3, -7, -15, -13, -10, -18, -30, -18, -17, -18, -27, -25, -17, -24, -29, -43, -28, -39, -43, -38, -35, -31, -43, -48, -55, -55, -48, -50, -50, -50, -57, -58, -49] },
  { midi: 48, levels: [0, -7, -15, -17, -19, -24, -26, -39, -30, -29, -32, -32, -39, -28, -21, -36, -47, -43, -40, -42, -50, -38, -42] },
  { midi: 51, levels: [0, -3, -4, -12, -20, -16, -16, -28, -17, -21, -25, -21, -27, -31, -23, -35, -44, -44, -40, -35, -50, -37, -46] },
  { midi: 54, levels: [0, -4, -10, -13, -15, -15, -8, -27, -23, -22, -29, -26, -28, -31, -30, -33, -41, -49, -30, -40, -53, -49] },
  { midi: 57, levels: [0, 0, -7, -10, -11, -17, -14, -23, -17, -26, -31, -27, -29, -25, -37, -31, -52, -49, -45] },
  { midi: 60, levels: [-1, 0, -17, -12, -12, -22, -16, -29, -28, -24, -29, -28, -23, -30, -38, -44] },
  { midi: 63, levels: [0, 0, -13, -14, -17, -22, -16, -24, -39, -28, -34, -37, -32, -45, -47] },
  { midi: 66, levels: [0, -6, -14, -20, -24, -23, -19, -25, -42, -41, -43, -51, -42] },
  { midi: 69, levels: [0, -11, -17, -25, -31, -27, -31, -28, -40, -41, -53, -52, -49, -50] },
  { midi: 72, levels: [0, -17, -16, -24, -24, -20, -28, -34, -37] },
  { midi: 75, levels: [0, -17, -23, -22, -21, -33, -41, -38] },
  { midi: 78, levels: [0, -22, -29, -37, -34, -40, -43] },
  { midi: 81, levels: [0, -13, -24, -30, -34, -40, -47] },
  { midi: 84, levels: [0, -8, -23, -21, -35, -40, -49, -48] },
  { midi: 87, levels: [0, -19, -32, -29, -50, -55, -50] },
  { midi: 90, levels: [0, -20, -29, -39, -47] },
  { midi: 93, levels: [0, -16, -39, -49] },
  { midi: 96, levels: [0, -22, -47] },
  { midi: 99, levels: [0, -27] },
]

/**
 * The touch: partial level change (dB) of a Salamander layer against the reference one (velocity
 * 85 ≈ 0.665), per octave band centred on TOUCH_BANDS, the median over every measured key.
 */
const TOUCH_BANDS = [125, 250, 500, 1000, 2000, 4000]
const TOUCH: readonly { velocity: number; db: readonly number[] }[] = [
  { velocity: 0.315, db: [-4.3, -5, -5.6, -8.4, -14.6, -23.7] },
  { velocity: 0.476, db: [-1.4, -1.6, -2, -2.8, -4.8, -7.7] },
  { velocity: 0.602, db: [-0.5, -0.8, -0.8, -1.1, -1.7, -2.7] },
  { velocity: 0.665, db: [0, 0, 0, 0, 0, 0] },
  { velocity: 0.728, db: [0.6, 0.5, 0.7, 0.9, 1.5, 2.2] },
  { velocity: 0.854, db: [2.6, 2.6, 3.1, 3.8, 6, 8] },
  { velocity: 0.976, db: [4.8, 4.9, 5.5, 6.8, 10.3, 13.9] },
]

/**
 * The decay model, fitted to both pianos: ln(prompt τ), ln(aftersound τ) (amplitude time constants,
 * s) and the aftersound's share of the power (dB), each a polynomial in x = (midi − 60) / 12 and
 * y = log2(f / 1000 Hz) with the terms [1, x, y, y², x·y, x²].
 */
const DECAY_PROMPT = [-1.1473, -0.179, -0.1978, -0.065, 0.0739, -0.0413]
const DECAY_AFTER = [0.6233, -0.1501, -0.2733, -0.0492, 0.0016, -0.0055]
const AFTER_SHARE = [-13.873, -4.3974, 1.275, -1.222, 0.7579, -0.5726]

/** Partials are kept below this (Hz; the recordings have nothing audible above it at this touch). */
const PARTIAL_LIMIT = 10000
const FLOOR_DB = -60
/** Spread of the per-partial decays (ln units) and aftersound share (dB), as scattered around the model. */
const DECAY_SPREAD = 0.2
const SHARE_SPREAD = 3
/** Beating of the unison strings: rate at 1 kHz (Hz), its growth with frequency, its spread (ln units). */
const BEAT_1K = 0.75
const BEAT_SLOPE = 0.5
const BEAT_SPREAD = 0.45
/** Steady tone RMS of a rendered note at the reference touch (before the engine's level). */
export const PIANO_RMS = 0.12
/** The touch the spectra were measured at (MIDI velocity 85). */
export const PIANO_REF_VELOCITY = 0.665
/** Knock level re the tone RMS (middle keys; up to KNOCK_TREBLE dB more around C6), its rise (s), the soundboard's shortest mode decay (s). */
const KNOCK_LEVEL = 0.7
const KNOCK_TREBLE = 11
const KNOCK_RISE = 0.022
const KNOCK_DECAY = 0.012
/** The key-up thud, re the tone RMS. */
const THUD_LEVEL = 0.025
/** Dampers: amplitude time constant at middle C (s), halving every 3 octaves up; no dampers from F6 up. */
const DAMPER_TAU = 0.05
const UNDAMPED_FROM = 89
/** Rendered after the key comes up: at most / at least (s). */
export const PIANO_TAIL_MAX = 1.6
const TAIL_MIN = 0.35
/** Components are stopped once this far under the tone RMS. */
const SILENCE = 1e-4

export interface PianoParams {
  sampleRate: number
  midi: number
  /** touch, 0..1 (rendered at the given value; the engine quantizes it) */
  velocity: number
  /** seconds the key stays down */
  hold: number
  seed: number
}

export function pianoParams(midi: number, velocity: number, hold: number, sampleRate: number): PianoParams {
  return { sampleRate, midi, velocity: clamp(velocity, 0, 1), hold: Math.max(0, hold), seed: 5303 + midi * 131 }
}

/** String stiffness B (partial n at n·f0·√(1 + B·n²)): flat in the wound bass, doubling every 8 semitones above (up to A6). */
export function inharmonicity(midi: number): number {
  return midi <= 45 ? 1e-4 : 1.1e-4 * Math.exp(0.0871 * (Math.min(midi, 93) - 48))
}

/** Stretch tuning (midi, cents), the mean of both recorded pianos re their A4, smoothed. */
const TUNING: readonly [number, number][] = [
  [21, -10],
  [33, -6],
  [45, -2],
  [60, -1],
  [69, 0],
  [72, 0.5],
  [84, 3.5],
  [96, 10],
  [108, 18],
]

/** Stretch tuning: cents from equal temperament with A4 = 440 Hz. */
export function pianoTuning(midi: number): number {
  const m = clamp(midi, TUNING[0][0], TUNING[TUNING.length - 1][0])
  let i = 0
  while (i < TUNING.length - 2 && TUNING[i + 1][0] <= m) i++
  const [m0, c0] = TUNING[i]
  const [m1, c1] = TUNING[i + 1]
  return c0 + ((m - m0) / (m1 - m0)) * (c1 - c0)
}

/** Measured partial levels (dB re the strongest) for `midi` at the reference touch, interpolated between keys. */
export function pianoSpectrum(midi: number): number[] {
  const s = PIANO_SPECTRA
  const m = clamp(midi, s[0].midi, s[s.length - 1].midi)
  let i = 0
  while (i < s.length - 2 && s[i + 1].midi <= m) i++
  const a = s[i]
  const b = s[i + 1]
  const t = clamp((m - a.midi) / (b.midi - a.midi), 0, 1)
  const n = Math.round((1 - t) * a.levels.length + t * b.levels.length)
  return Array.from({ length: n }, (_, k) => (1 - t) * (a.levels[k] ?? FLOOR_DB) + t * (b.levels[k] ?? FLOOR_DB))
}

/** Level change (dB) of a partial at `freq` for a touch `velocity`, re the reference touch. */
export function pianoTouch(velocity: number, freq: number): number {
  const v = clamp(velocity, TOUCH[0].velocity, TOUCH[TOUCH.length - 1].velocity)
  let i = 0
  while (i < TOUCH.length - 2 && TOUCH[i + 1].velocity <= v) i++
  const w = (v - TOUCH[i].velocity) / (TOUCH[i + 1].velocity - TOUCH[i].velocity)
  const band = clamp(Math.log2(freq / TOUCH_BANDS[0]), 0, TOUCH_BANDS.length - 1)
  const k = Math.min(TOUCH_BANDS.length - 2, Math.floor(band))
  const f = band - k
  const at = (row: readonly number[]) => row[k] + f * (row[k + 1] - row[k])
  return (1 - w) * at(TOUCH[i].db) + w * at(TOUCH[i + 1].db)
}

function poly(c: readonly number[], x: number, y: number): number {
  return c[0] + c[1] * x + c[2] * y + c[3] * y * y + c[4] * x * y + c[5] * x * x
}

/** The decay model at a partial: prompt and aftersound amplitude time constants (s), the aftersound's power share. */
export function pianoDecay(midi: number, freq: number): { prompt: number; after: number; share: number } {
  const x = clamp((midi - 60) / 12, -2.5, 3.25)
  const y = clamp(Math.log2(freq / 1000), -3.5, 3.4)
  return {
    prompt: Math.exp(poly(DECAY_PROMPT, x, y)),
    after: Math.exp(poly(DECAY_AFTER, x, y)),
    share: Math.pow(10, clamp(poly(AFTER_SHARE, x, y), -45, -5) / 10),
  }
}

/** Damper amplitude time constant after key up for a partial at `freq` (s); Infinity above the dampers. */
export function damperTime(midi: number, freq: number): number {
  if (midi >= UNDAMPED_FROM) return Infinity
  return (DAMPER_TAU * Math.pow(2, -(midi - 60) / 36)) / (1 + freq / 4000)
}

/** Hammer contact time (s): ~4 ms in the bass, ~1 ms at the top, shorter for a harder touch. */
export function hammerContact(midi: number, velocity: number): number {
  return clamp(0.0024 * Math.pow(2, -(midi - 60) / 30), 0.0008, 0.0045) * (1.25 - 0.4 * clamp(velocity, 0, 1))
}

/** The knock against the tone (dB): as in the middle up to E5, ~9 dB stronger A5–F♯6, less again at the very top (as measured). */
function knockBoost(midi: number): number {
  return KNOCK_TREBLE * clamp((midi - 76) / 8, 0, 1) - 1.5 * Math.max(0, midi - 90)
}

/** Loudness across the keyboard (dB): flat up to F♯6, then the top keys get quieter (as measured). */
function keyLevel(midi: number): number {
  return midi <= 90 ? 0 : -0.4 * (midi - 90)
}

/** White noise through a one-pole highpass at `lo` and two one-pole lowpasses at `hi` (Hz), unit RMS. */
function bandNoise(length: number, sampleRate: number, lo: number, hi: number, rand: () => number): Float32Array {
  const out = new Float32Array(length)
  const hp = Math.exp((-2 * Math.PI * lo) / sampleRate)
  const lp = Math.exp((-2 * Math.PI * hi) / sampleRate)
  let h = 0
  let x1 = 0
  let l1 = 0
  let l2 = 0
  let sum = 0
  for (let i = 0; i < length; i++) {
    const x = rand() * 2 - 1
    h = hp * (h + x - x1)
    x1 = x
    l1 += (1 - lp) * (h - l1)
    l2 += (1 - lp) * (l1 - l2)
    out[i] = l2
    sum += l2 * l2
  }
  const k = sum > 0 ? 1 / Math.sqrt(sum / length) : 0
  for (let i = 0; i < length; i++) out[i] *= k
  return out
}

/** Standard-ish normal number from a uniform generator (sum of three, variance 1). */
function gauss(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) * 2
}

// The soundboard's response to a hammer blow, per sample rate: 160 decaying modes 40 Hz – 8 kHz with
// decays spread 12–150 ms (louder the shorter: the knock falls ~6 dB per doubling of time, as
// measured), each octave band scaled to the measured knock spectrum over the first 25 ms; unit RMS
// over those 25 ms.
const KNOCK_BANDS = [-13, -6, 0, 0, 2, 2, -2, -12, -24] // dB per octave band from 31.5 Hz
const boards = new Map<number, Float32Array>()

function soundboard(sampleRate: number): Float32Array {
  const have = boards.get(sampleRate)
  if (have) return have
  const length = Math.round(0.4 * sampleRate)
  const out = new Float32Array(length)
  const rand = mulberry32(31337)
  const window = 0.025
  const modes: { f: number; tau: number; amp: number; phase: number; band: number }[] = []
  const energy = new Array<number>(KNOCK_BANDS.length).fill(0)
  for (let k = 0; k < 160; k++) {
    // denser up the spectrum, like a plate's modes
    const f = 40 * Math.pow(200, Math.pow((k + rand()) / 160, 0.8))
    if (f > sampleRate * 0.45) continue
    const tau = KNOCK_DECAY * Math.pow(12.5, rand())
    const amp = (0.6 + 0.8 * rand()) / tau
    const band = clamp(Math.floor(Math.log2(f / 31.5)), 0, KNOCK_BANDS.length - 1)
    energy[band] += ((amp * amp) / 2) * (tau / 2) * (1 - Math.exp((-2 * window) / tau))
    modes.push({ f, tau, amp, phase: rand() * 2 * Math.PI, band })
  }
  for (const m of modes) {
    const amp = m.amp * Math.sqrt(Math.pow(10, KNOCK_BANDS[m.band] / 10) / energy[m.band])
    const w = (2 * Math.PI * m.f) / sampleRate
    const r = Math.exp(-1 / (m.tau * sampleRate))
    const c = 2 * r * Math.cos(w)
    const q = r * r
    let y1 = (amp * Math.sin(m.phase - w)) / r
    let y2 = (amp * Math.sin(m.phase - 2 * w)) / (r * r)
    const end = Math.min(length, Math.ceil(m.tau * 9 * sampleRate))
    for (let i = 0; i < end; i++) {
      const y0 = c * y1 - q * y2
      out[i] += y0
      y2 = y1
      y1 = y0
    }
  }
  let sum = 0
  const n = Math.round(window * sampleRate)
  for (let i = 0; i < n; i++) sum += out[i] * out[i]
  const k = sum > 0 ? 1 / Math.sqrt(sum / n) : 0
  for (let i = 0; i < length; i++) out[i] *= k
  boards.set(sampleRate, out)
  return out
}

interface Component {
  amp: number
  freq: number
  tau: number
  damp: number
  phase: number
}

/** Renders one piano key: mono, `hold` + tail seconds, starting and ending at silence. */
export function renderPiano(p: PianoParams): Float32Array {
  const fs = p.sampleRate
  const rand = mulberry32(p.seed)
  const f0 = midiToFreq(p.midi) * Math.pow(2, pianoTuning(p.midi) / 1200)
  const B = inharmonicity(p.midi)
  const levels = pianoSpectrum(p.midi)
  const limit = Math.min(PARTIAL_LIMIT, fs * 0.45)

  // the partials: reference levels set the note's loudness, the touch changes them from there
  const comps: Component[] = []
  let refPower = 0
  const partials: { freq: number; amp: number }[] = []
  for (let k = 0; k < levels.length; k++) {
    const n = k + 1
    const freq = n * f0 * Math.sqrt(1 + B * n * n)
    if (freq >= limit || levels[k] <= FLOOR_DB) continue
    const ref = Math.pow(10, levels[k] / 20)
    refPower += (ref * ref) / 2
    partials.push({ freq, amp: ref * Math.pow(10, pianoTouch(p.velocity, freq) / 20) })
  }
  const scale = refPower > 0 ? (PIANO_RMS * Math.pow(10, keyLevel(p.midi) / 20)) / Math.sqrt(refPower) : 0
  const silence = SILENCE * PIANO_RMS
  for (const { freq, amp } of partials) {
    const d = pianoDecay(p.midi, freq)
    const prompt = d.prompt * Math.exp(DECAY_SPREAD * gauss(rand))
    const after = Math.max(prompt * 1.5, d.after * Math.exp(DECAY_SPREAD * gauss(rand)))
    const share = clamp(d.share * Math.pow(10, (SHARE_SPREAD * gauss(rand)) / 10), 0, 0.5)
    const beat = clamp(BEAT_1K * Math.pow(freq / 1000, BEAT_SLOPE) * Math.exp(BEAT_SPREAD * gauss(rand)), 0.15, 6)
    const damp = damperTime(p.midi, freq)
    const a = amp * scale
    // the prompt sound, and two unison strings beating against it in the aftersound
    comps.push({ amp: a * Math.sqrt(1 - share), freq, tau: prompt, damp, phase: rand() * 2 * Math.PI })
    const slow = a * Math.sqrt(share)
    if (slow > silence) {
      comps.push({ amp: slow * 0.8, freq: freq + 0.6 * beat, tau: after * 1.08, damp, phase: rand() * 2 * Math.PI })
      comps.push({ amp: slow * 0.6, freq: freq - 0.4 * beat, tau: after * 0.92, damp, phase: rand() * 2 * Math.PI })
    }
  }

  // how long each component sounds, and the note's length
  const hold = Math.round(p.hold * fs)
  let tail = TAIL_MIN
  const ends = comps.map((c) => {
    const atHold = c.amp * Math.exp(-p.hold / c.tau)
    if (atHold <= silence) return Math.max(0, Math.ceil(c.tau * Math.log(c.amp / silence) * fs))
    const tau = 1 / (1 / c.tau + 1 / c.damp)
    const after = Math.min(PIANO_TAIL_MAX, tau * Math.log(atHold / silence))
    tail = Math.max(tail, after)
    return hold + Math.ceil(after * fs)
  })
  const length = hold + Math.ceil(Math.min(PIANO_TAIL_MAX, tail) * fs)
  const acc = new Float64Array(length)

  // every component is a damped sinusoid: y[i] = c·y[i−1] − q·y[i−2], the damper joining at key up
  for (let ci = 0; ci < comps.length; ci++) {
    const c = comps[ci]
    const end = Math.min(length, ends[ci])
    if (end <= 0) continue
    const w = (2 * Math.PI * c.freq) / fs
    const r = Math.exp(-1 / (c.tau * fs))
    const rd = r * (Number.isFinite(c.damp) ? Math.exp(-1 / (c.damp * fs)) : 1)
    let y1 = (c.amp * Math.sin(c.phase - w)) / r
    let y2 = (c.amp * Math.sin(c.phase - 2 * w)) / (r * r)
    let k1 = 2 * r * Math.cos(w)
    let q = r * r
    const split = Math.min(end, hold)
    for (let i = 0; i < split; i++) {
      const y0 = k1 * y1 - q * y2
      acc[i] += y0
      y2 = y1
      y1 = y0
    }
    k1 = 2 * rd * Math.cos(w)
    q = rd * rd
    for (let i = split; i < end; i++) {
      const y0 = k1 * y1 - q * y2
      acc[i] += y0
      y2 = y1
      y1 = y0
    }
  }

  // the strings build up while the hammer touches them
  const contact = hammerContact(p.midi, p.velocity)
  const rise = Math.max(1, Math.round(contact * fs))
  for (let i = 0; i < Math.min(rise, length); i++) acc[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rise)

  // the knock: the soundboard's response, a little darker for the longer bass hammer contact
  const board = soundboard(fs)
  const touch = Math.pow(10, pianoTouch(p.velocity, 500) / 20)
  const knock = KNOCK_LEVEL * PIANO_RMS * Math.pow(10, (keyLevel(p.midi) + knockBoost(p.midi)) / 20) * touch
  const a = Math.exp((-2 * Math.PI * clamp(3 / contact, 200, fs * 0.4)) / fs)
  const knockRise = Math.round(KNOCK_RISE * fs)
  let l1 = 0
  let l2 = 0
  for (let i = 0; i < Math.min(board.length, length); i++) {
    l1 += (1 - a) * (board[i] - l1)
    l2 += (1 - a) * (l1 - l2)
    const env = i < knockRise ? 0.5 - 0.5 * Math.cos((Math.PI * i) / knockRise) : 1
    acc[i] += knock * env * l2
  }

  // key up: the action's soft thud (100 Hz – 1.2 kHz noise, ~40 ms up, ~60 ms down)
  if (hold < length) {
    const n = Math.min(length - hold, Math.round(0.3 * fs))
    const noise = bandNoise(n, fs, 100, 1200, rand)
    const thud = THUD_LEVEL * PIANO_RMS * touch
    for (let i = 0; i < n; i++) {
      const t = i / fs
      const env = t < 0.04 ? Math.sin((Math.PI / 2) * (t / 0.04)) : Math.exp(-(t - 0.04) / 0.06)
      acc[hold + i] += thud * env * noise[i]
    }
  }

  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = acc[i]
  // a last 5 ms fade
  const fade = Math.min(length, Math.round(0.005 * fs))
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade
  return out
}
