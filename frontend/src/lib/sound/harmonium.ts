// Harmonium (Indian, hand-pumped, the bass + male reed banks drawn) note, rebuilt from a recording of
// a real one: Freesound #330410 "Harmonium Samples - All Keys and Drones" by donyaquick (Yale,
// Euterpea Studio; CC0), every key held ~10 s. What the analysis of that recording found, and what
// this voice reproduces:
//  - every key sounds two reeds: one at the written pitch and a bass reed an octave below, tuned a
//    few cents apart, differently on every key (−8…+17.5 cents) — the slow beating that makes the
//    instrument sound alive;
//  - each reed's own harmonic spectrum, measured on every key (a 3-key median, kept every minor
//    third in HARMONIUM_SPECTRA, interpolated in dB between them);
//  - speech: a reed needs ~17 of its periods to speak — the main reed's fundamental first, its upper
//    harmonics after about one more speech time, the bass reed lagging behind and blooming last;
//  - release: the pallet closes and the reeds stop at once (−20 dB in ~27 ms);
//  - the bellows: the level wanders ±0.5 dB, the pitch about a cent; air noise ~40 dB under the
//    tone (pink, 300 Hz – 6 kHz) and a short bright click as the pallet opens.
// Rendered offline into a Float32Array once per (key, hold, sample rate) — the engine caches it.

import { clamp, filterInPlace, lowpassBiquad, midiToFreq, mulberry32 } from './dsp'

/** One measured key: harmonic levels (dB re the key's strongest partial) of each reed, 1st harmonic first. */
export interface ReedSpectrum {
  midi: number
  main: readonly number[]
  bass: readonly number[]
}

/** Measured spectra every minor third, C3–C6 (harmonics above 8 kHz or under −60 dB left out). */
export const HARMONIUM_SPECTRA: readonly ReedSpectrum[] = [
  { midi: 48, main: [-3, 0, 0, -10, -1, -13, -10, -13, -20, -22, -19, -20, -20, -16], bass: [-9, -10, -8, -20, -13, -19, -16, -20, -19, -23, -20, -26, -28, -27, -28, -27, -32, -38, -39, -39, -42, -40, -41, -36, -41, -43, -39, -37] },
  { midi: 51, main: [-2, -4, 0, -12, -8, -13, -13, -19, -21, -23, -24, -27, -26, -25], bass: [-13, -10, -13, -22, -18, -17, -20, -25, -22, -31, -27, -33, -35, -42, -46, -47, -48, -47, -50, -52, -54, -58, -58, -60, -54, -52, -50, -50] },
  { midi: 54, main: [-2, -2, 0, -13, -6, -14, -16, -18, -23, -30, -23, -21, -21, -18], bass: [-12, -9, -13, -18, -15, -15, -20, -20, -24, -25, -25, -30, -32, -37, -39, -43, -41, -42, -45, -48, -50, -46, -42, -44, -44, -47, -51, -49] },
  { midi: 57, main: [0, 0, -1, -14, -7, -15, -17, -19, -29, -17, -16, -18, -18, -19], bass: [-3, -9, -11, -20, -14, -23, -20, -23, -23, -30, -31, -35, -38, -39, -42, -43, -47, -56, -50, -49, -48, -55, -54, -56, -55, -55, -53, -58] },
  { midi: 60, main: [-1, -1, 0, -12, -9, -11, -15, -14, -21, -28, -39, -29, -31, -30], bass: [-2, -10, -7, -20, -13, -16, -21, -20, -23, -25, -29, -30, -34, -35, -36, -35, -40, -43, -47, -49, -56, -56, -51, -50, -55, -60, -55, -55] },
  { midi: 63, main: [-5, -4, 0, -12, -7, -7, -12, -14, -15, -18, -26, -31, -37, -49], bass: [-6, -9, -5, -20, -10, -16, -16, -19, -19, -22, -26, -24, -26, -29, -32, -30, -43, -37, -44, -32, -47, -44, -50, -46, -53, -49, -52, -53] },
  { midi: 66, main: [0, -5, -3, -12, -8, -10, -14, -12, -15, -19, -21, -23, -24, -32], bass: [-7, -8, -5, -19, -13, -16, -17, -19, -20, -22, -24, -23, -24, -30, -33, -32, -31, -36, -35, -42, -40, -46, -41, -46, -43, -50, -52, -55] },
  { midi: 69, main: [0, -9, -3, -13, -8, -10, -16, -19, -20, -22, -29, -34, -40, -44], bass: [-8, -7, -8, -19, -13, -17, -17, -20, -21, -21, -22, -27, -32, -29, -32, -33, -34, -37, -39, -42, -43, -46, -49, -53, -50, -50, -52, -57] },
  { midi: 72, main: [0, -10, -6, -16, -14, -20, -17, -26, -26, -31, -30, -41, -36, -55], bass: [-6, -6, -6, -21, -14, -17, -22, -24, -25, -30, -34, -34, -37, -35, -42, -41, -44, -46, -52, -49, -52, -47, -50, -49, -53, -56] },
  { midi: 75, main: [0, -15, -9, -27, -17, -15, -21, -22, -27, -36, -43, -45], bass: [-7, -6, -8, -22, -13, -20, -20, -33, -31, -30, -25, -28, -35, -31, -37, -35, -35, -37, -41, -42, -43, -47, -52, -52, -47] },
  { midi: 78, main: [0, -25, -11, -13, -17, -16, -31, -28, -42, -47], bass: [-5, -7, -11, -24, -16, -20, -27, -19, -26, -26, -32, -29, -35, -34, -39, -36, -44, -38, -47, -52, -47] },
  { midi: 81, main: [0, -22, -7, -12, -15, -21, -28, -32, -39], bass: [0, -7, -15, -24, -10, -20, -15, -23, -24, -26, -37, -31, -38, -36, -36, -38, -46, -45] },
  { midi: 84, main: [-1, -23, -6, -24, -18, -24, -41], bass: [0, -10, -20, -22, -11, -18, -33, -31, -32, -33, -43, -36, -45, -48, -50] },
]

/** Main reed vs twice the bass reed, cents, per key from C3 (MIDI 48) up — as measured. */
const DETUNE = [13, 9, 17.5, 5, -8, 8.5, 12, 5, 7.5, 12.5, 4.5, 9, 3, 3.5, 1, 3, 1, 2.5, 11, 1.5, 0, 3, 2, 2.5, 1.5, -1, 3.5, 1, 8, 0, -4, -1.5, 2.5, -1, 0.5, 6, 8]
const DETUNE_LOW = 48

/** Harmonics are kept below this (Hz; the recording has nothing audible above it). */
const HARMONIC_LIMIT = 8000
const FLOOR_DB = -60
/** The bass reed starts this fraction of its speech time after the main one. */
const BASS_LAG = 0.25
/** A reed's upper harmonics start this many speech times in, and take this many to come up. */
const UPPER_DELAY = 0.9
const UPPER_SPEECH = 1.4
/** Exponential decay after the key comes up, s (−20 dB in ~28 ms). */
export const HARMONIUM_RELEASE = 0.012
/** Rendered after the key comes up, s. */
export const HARMONIUM_TAIL = 0.12
/** Steady RMS of a rendered note (before the engine's level). */
export const HARMONIUM_RMS = 0.12
/** Louder up the keyboard: dB per semitone (half the recording's 0.15). */
const LEVEL_SLOPE = 0.075
const NOISE_DB = -40
/** The pallet's click as the key goes down: a few ms of bright noise. */
const CLICK_DB = -24
const CLICK_DECAY = 0.006
/** The bellows: level wander (dB) and its knot spacing (s); pitch wander of each reed (cents, s). */
const BELLOWS_DB = 0.5
const BELLOWS_STEP = 0.8
const WANDER_CENTS = 0.8
const WANDER_STEP = 0.35
/** Samples per control step (envelopes, wander), interpolated linearly in between. */
const BLOCK = 32
const TABLE = 2048

export interface HarmoniumParams {
  sampleRate: number
  midi: number
  /** seconds the key stays down */
  hold: number
  seed: number
}

export function harmoniumParams(midi: number, hold: number, sampleRate: number): HarmoniumParams {
  return { sampleRate, midi, hold: Math.max(0, hold), seed: 7741 + midi * 337 }
}

/** The main reed's detune from twice the bass reed, cents (outside C3–C6: the nearest key's). */
export function harmoniumDetune(midi: number): number {
  return DETUNE[clamp(Math.round(midi) - DETUNE_LOW, 0, DETUNE.length - 1)]
}

/** Harmonic levels (dB) of both reeds for `midi`, interpolated between the measured keys. */
export function harmoniumSpectrum(midi: number): { main: number[]; bass: number[] } {
  const s = HARMONIUM_SPECTRA
  const m = clamp(midi, s[0].midi, s[s.length - 1].midi)
  let i = 0
  while (i < s.length - 2 && s[i + 1].midi <= m) i++
  const a = s[i]
  const b = s[i + 1]
  const t = clamp((m - a.midi) / (b.midi - a.midi), 0, 1)
  const mix = (x: readonly number[], y: readonly number[]) =>
    Array.from({ length: Math.max(x.length, y.length) }, (_, k) => (1 - t) * (x[k] ?? FLOOR_DB) + t * (y[k] ?? FLOOR_DB))
  return { main: mix(a.main, b.main), bass: mix(a.bass, b.bass) }
}

/** Time a reed sounding `freq` takes to speak, s: ~17 periods (measured at 87 and 175 Hz), 25–200 ms. */
export function reedSpeech(freq: number): number {
  return clamp(0.1 * Math.pow(175 / freq, 0.7), 0.025, 0.2)
}

/** Speech curve over u = t / speech time: −40 dB at the start, rising almost linearly in dB into a soft knee. */
export function speechCurve(u: number): number {
  if (u <= 0) return 0.01
  if (u >= 1) return 1
  return Math.pow(10, (-2 * Math.pow(1 - u, 1.4)))
}

interface Reed {
  inc: number
  fundamental: Float32Array
  upper: Float32Array
  speech: number
  lag: number
  phase: number
  wander: Float64Array
}

/** One period of the reed's fundamental and of its upper harmonics (seeded phases), with a guard sample. */
function reedTables(levels: readonly number[], freq: number, sampleRate: number, rand: () => number): { fundamental: Float32Array; upper: Float32Array; power: number } {
  const fundamental = new Float32Array(TABLE + 1)
  const upper = new Float32Array(TABLE + 1)
  let power = 0
  const limit = Math.min(HARMONIC_LIMIT, sampleRate * 0.45)
  for (let k = 1; k <= levels.length; k++) {
    const phase = rand() * 2 * Math.PI
    if (k * freq >= limit || levels[k - 1] <= FLOOR_DB) continue
    const amp = Math.pow(10, levels[k - 1] / 20)
    power += (amp * amp) / 2
    const table = k === 1 ? fundamental : upper
    const w = (2 * Math.PI * k) / TABLE
    for (let i = 0; i <= TABLE; i++) table[i] += amp * Math.sin(w * i + phase)
  }
  return { fundamental, upper, power }
}

/** Smooth random curve in [−1, 1]: knots every `step` s, cosine-interpolated, sampled once per block. */
function wanderCurve(rand: () => number, blocks: number, blockSeconds: number, step: number): Float64Array {
  const knots = Array.from({ length: Math.ceil((blocks * blockSeconds) / step) + 2 }, () => rand() * 2 - 1)
  const out = new Float64Array(blocks + 1)
  for (let b = 0; b <= blocks; b++) {
    const x = (b * blockSeconds) / step
    const i = Math.floor(x)
    const f = 0.5 - 0.5 * Math.cos(Math.PI * (x - i))
    out[b] = knots[i] * (1 - f) + knots[i + 1] * f
  }
  return out
}

/** Pink-ish noise (Paul Kellet's economy filter), unit RMS, band-limited to [lo, hi] Hz. */
function airNoise(length: number, sampleRate: number, lo: number, hi: number, rand: () => number): Float32Array {
  const out = new Float32Array(length)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < length; i++) {
    const w = rand() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    out[i] = b0 + b1 + b2 + w * 0.1848
  }
  filterInPlace(out, lowpassBiquad(sampleRate, hi))
  // one-pole highpass
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

/** Renders one harmonium key: mono, `hold` + HARMONIUM_TAIL seconds, starting and ending at silence. */
export function renderHarmonium(p: HarmoniumParams): Float32Array {
  const fs = p.sampleRate
  const length = Math.max(BLOCK, Math.round((p.hold + HARMONIUM_TAIL) * fs))
  const out = new Float32Array(length)
  const rand = mulberry32(p.seed)
  const levels = harmoniumSpectrum(p.midi)
  const fMain = midiToFreq(p.midi)
  const fBass = (fMain / 2) * Math.pow(2, -harmoniumDetune(p.midi) / 1200)
  const blocks = Math.ceil(length / BLOCK)
  const blockSeconds = BLOCK / fs

  let power = 0
  const reeds: Reed[] = [
    [levels.main, fMain, 0],
    [levels.bass, fBass, BASS_LAG],
  ].map(([lv, freq, lag]) => {
    const f = freq as number
    const tables = reedTables(lv as number[], f, fs, rand)
    power += tables.power
    const speech = reedSpeech(f)
    return {
      inc: (f * TABLE) / fs,
      fundamental: tables.fundamental,
      upper: tables.upper,
      speech,
      lag: (lag as number) * speech,
      phase: rand() * TABLE,
      wander: wanderCurve(rand, blocks, blockSeconds, WANDER_STEP),
    }
  })
  // the bellows are shared by every key: the same curve whatever the seed
  const bellows = wanderCurve(mulberry32(9001), blocks, blockSeconds, BELLOWS_STEP)
  const toneRms = Math.sqrt(power)
  const scale = toneRms > 0 ? (HARMONIUM_RMS * Math.pow(10, (LEVEL_SLOPE * (p.midi - 66)) / 20)) / toneRms : 0
  const noise = airNoise(length, fs, 300, 6000, rand)
  const click = airNoise(Math.min(length, Math.round(0.05 * fs)), fs, 1000, Math.min(10000, fs * 0.45), rand)
  const noteRms = scale * toneRms
  const noiseLevel = noteRms * Math.pow(10, NOISE_DB / 20)
  const clickLevel = noteRms * Math.pow(10, CLICK_DB / 20)

  // per-block control values: [fundamental env, upper env, phase increment] per reed, release gain
  const control = (b: number) => {
    const t = b * blockSeconds
    const rel = t <= p.hold ? 1 : Math.exp(-(t - p.hold) / HARMONIUM_RELEASE)
    const gate = Math.min(1, t / 0.003) // no click at the very start
    const gain = scale * rel * gate * Math.pow(10, (BELLOWS_DB * bellows[b]) / 20)
    return reeds.map((r) => [
      gain * speechCurve((t - r.lag) / r.speech),
      gain * speechCurve((t - r.lag - UPPER_DELAY * r.speech) / (UPPER_SPEECH * r.speech)),
      r.inc * Math.pow(2, (WANDER_CENTS * r.wander[b]) / 1200),
    ])
  }

  let now = control(0)
  for (let b = 0; b < blocks; b++) {
    const next = control(b + 1)
    const from = b * BLOCK
    const to = Math.min(length, from + BLOCK)
    for (let ri = 0; ri < reeds.length; ri++) {
      const r = reeds[ri]
      const [e1, eh, inc] = now[ri]
      const [n1, nh, ninc] = next[ri]
      const d1 = (n1 - e1) / BLOCK
      const dh = (nh - eh) / BLOCK
      const dinc = (ninc - inc) / BLOCK
      let phase = r.phase
      for (let i = from, j = 0; i < to; i++, j++) {
        const k = phase | 0
        const f = phase - k
        const fund = r.fundamental[k] + f * (r.fundamental[k + 1] - r.fundamental[k])
        const up = r.upper[k] + f * (r.upper[k + 1] - r.upper[k])
        out[i] += (e1 + d1 * j) * fund + (eh + dh * j) * up
        phase += inc + dinc * j
        if (phase >= TABLE) phase -= TABLE
      }
      r.phase = phase
    }
    // air: follows the main reed's speech and the release
    for (let i = from, j = 0; i < to; i++, j++) {
      const t = i / fs
      const air = scale > 0 ? ((now[0][0] + ((next[0][0] - now[0][0]) * j) / BLOCK) / scale) * noiseLevel : 0
      let v = air * noise[i]
      if (i < click.length) v += clickLevel * Math.min(1, t / 0.0005) * Math.exp(-t / CLICK_DECAY) * click[i]
      out[i] += v
    }
    now = next
  }
  // a last 5 ms fade (the release has long been under −80 dB)
  const fade = Math.min(length, Math.round(0.005 * fs))
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade
  return out
}
