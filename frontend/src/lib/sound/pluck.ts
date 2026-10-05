// Plucked strings for the guitar (steel), ukulele (nylon) and bass (round-wound, fingerstyle) chord
// sound: extended Karplus-Strong rendered offline into a Float32Array, once per pitch per sample rate
// (the engine caches them).
//
// Loop: y[n] = allpass(lowpass(y[n − N])), the delay line primed with one period of noise.
//  - tuning: N integer samples + the loop lowpass' phase delay + a first-order allpass solved for
//    the exact remaining fraction at the fundamental, so the pitch is accurate to a cent or so;
//  - damping: the loop lowpass `(1 − s) + s·z⁻¹` makes high partials die faster (frequency-dependent),
//    its gain sets the fundamental's T60;
//  - pluck position: a comb on the excitation removes the partials with a node at the pluck point;
//  - body: a couple of peaking resonances plus a lowpass, applied to the output.

import { clamp, filterInPlace, lowpassBiquad, midiToFreq, mulberry32, peakingEq } from './dsp'

export type PluckInstrument = 'guitar' | 'ukulele' | 'bass'

export interface BodyResonance {
  freq: number
  q: number
  gain: number
}

export interface PluckParams {
  sampleRate: number
  /** fundamental, Hz */
  frequency: number
  /** seconds for the fundamental to fall by 60 dB */
  t60: number
  /** loop lowpass weight 0..0.5: higher = high partials die sooner (duller string) */
  damping: number
  /** pluck point as a fraction of the string length */
  position: number
  /** excitation spectrum: partial k starts at k^−tilt (1 = a plucked string's bridge force) */
  tilt: number
  /** excitation brightness: the pick / nail lowpass, Hz */
  pickCutoff: number
  /** rendered length, seconds */
  duration: number
  seed: number
  body: readonly BodyResonance[]
  /** final lowpass, Hz */
  lowpass: number
}

interface PluckModel {
  t60(freq: number): number
  damping(freq: number): number
  position: number
  tilt: number
  pickCutoff: number
  maxDuration: number
  body: readonly BodyResonance[]
  lowpass: number
}

const MODELS: Record<PluckInstrument, PluckModel> = {
  // Steel strings: long sustain (the low strings longest), bright pick, dreadnought-ish body
  // (air resonance ~100 Hz, top plate ~200 Hz).
  guitar: {
    t60: (f) => clamp(5.4 * Math.pow(82.41 / f, 0.28), 2.4, 6),
    damping: (f) => clamp(0.3 * Math.pow(82.41 / f, 0.42), 0.1, 0.32),
    position: 0.13,
    tilt: 1,
    pickCutoff: 5200,
    maxDuration: 3.6,
    body: [
      { freq: 100, q: 2.2, gain: 4 },
      { freq: 205, q: 2, gain: 3.5 },
      { freq: 3200, q: 0.9, gain: -2 },
    ],
    lowpass: 6500,
  },
  // Nylon on a small body: shorter, higher resonances, but a brighter strum (nails) and more air on top.
  ukulele: {
    t60: (f) => clamp(2.6 * Math.pow(392 / f, 0.3), 1.4, 3.2),
    damping: (f) => clamp(0.24 * Math.pow(261.63 / f, 0.3), 0.1, 0.3),
    position: 0.2,
    tilt: 0.9,
    pickCutoff: 7500,
    maxDuration: 2.6,
    body: [
      { freq: 270, q: 2, gain: 3 },
      { freq: 560, q: 2.2, gain: 3.5 },
    ],
    lowpass: 9000,
  },
  // Electric bass, fingerstyle: long sustain, a dark round tone (the finger's soft attack, high
  // partials damped fast), no acoustic body — a pickup's low bump and a mid "growl" that keeps it
  // audible on small speakers, which cannot reproduce E1 (41 Hz).
  bass: {
    t60: (f) => clamp(5.8 * Math.pow(41.2 / f, 0.25), 3.2, 6),
    damping: (f) => clamp(0.42 * Math.pow(41.2 / f, 0.3), 0.18, 0.45),
    position: 0.18,
    tilt: 1.1,
    pickCutoff: 2500,
    maxDuration: 4,
    body: [
      { freq: 90, q: 1.2, gain: 3 },
      { freq: 700, q: 1.1, gain: 4 },
    ],
    lowpass: 3500,
  },
}

const INSTRUMENT_SEED: Record<PluckInstrument, number> = { guitar: 7919, ukulele: 104729, bass: 15485863 }

/** Rendering parameters for one string of the instrument sounding `midi`. */
export function pluckParams(instrument: PluckInstrument, midi: number, sampleRate: number): PluckParams {
  const m = MODELS[instrument]
  const frequency = midiToFreq(midi)
  const t60 = m.t60(frequency)
  return {
    sampleRate,
    frequency,
    t60,
    damping: m.damping(frequency),
    position: m.position,
    tilt: m.tilt,
    pickCutoff: m.pickCutoff,
    duration: Math.min(m.maxDuration, t60 * 0.8),
    seed: INSTRUMENT_SEED[instrument] + midi * 131,
    body: m.body,
    lowpass: m.lowpass,
  }
}

/**
 * When the string has faded enough to count as released (−30 dB, i.e. half its T60), seconds after
 * the pluck — the `end` of its live note. Capped inside the rendered buffer.
 */
export function pluckRelease(p: Pick<PluckParams, 't60' | 'duration'>): number {
  return Math.min(p.t60 / 2, p.duration * 0.9)
}

/**
 * First-order allpass coefficient `c` of `(c + z⁻¹) / (1 + c·z⁻¹)` whose phase delay at `w`
 * (rad/sample) equals `delay` samples. `delay` is expected in [0.5, 1.5).
 */
export function allpassCoefficient(delay: number, w: number): number {
  const phaseDelay = (c: number) => {
    const num = Math.atan2(-Math.sin(w), c + Math.cos(w))
    const den = Math.atan2(-c * Math.sin(w), 1 + c * Math.cos(w))
    return -(num - den) / w
  }
  // Phase delay falls monotonically as c grows; in this range nothing wraps around ±π.
  let lo = -0.6
  let hi = 0.9
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (phaseDelay(mid) > delay) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * One period of the pluck, built in the frequency domain so every pitch gets the same tone colour:
 * partial k has amplitude k^−tilt (a plucked string's bridge force falls ~1/k), times the
 * pluck-position comb |sin(πkβ)| and the pick's lowpass, with a seeded random phase (a noise-like
 * attack that is still the same on every play). Peak-normalized; no DC.
 */
function excitation(n: number, p: PluckParams): Float64Array {
  const rand = mulberry32(p.seed)
  const out = new Float64Array(n)
  const f0 = p.sampleRate / n
  const harmonics = Math.floor((n - 1) / 2)
  for (let k = 1; k <= harmonics; k++) {
    const f = k * f0
    if (f > p.sampleRate * 0.45) break
    const amp = (Math.pow(k, -p.tilt) * Math.abs(Math.sin(Math.PI * k * p.position))) / Math.sqrt(1 + (f / p.pickCutoff) ** 2)
    const phase = rand() * 2 * Math.PI
    if (amp < 1e-4) continue
    // rotate a phasor instead of calling cos() per sample
    const w = (2 * Math.PI * k) / n
    const cw = Math.cos(w)
    const sw = Math.sin(w)
    let re = Math.cos(phase)
    let im = Math.sin(phase)
    for (let i = 0; i < n; i++) {
      out[i] += amp * re
      const r = re * cw - im * sw
      im = re * sw + im * cw
      re = r
    }
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

/** Target loudness of a rendered string (RMS over its first 120 ms) and its peak ceiling. */
const TARGET_RMS = 0.2
const PEAK_CEILING = 0.95

/** Renders one plucked string. Mono, `duration` seconds, already faded in and out. */
export function renderPluck(p: PluckParams): Float32Array {
  const fs = p.sampleRate
  const period = fs / p.frequency
  const w0 = (2 * Math.PI) / period
  const s = clamp(p.damping, 0, 0.5)
  // loop lowpass at the fundamental: magnitude (to hit T60) and phase delay (for tuning)
  const re = 1 - s + s * Math.cos(w0)
  const im = -s * Math.sin(w0)
  const lpGain = Math.hypot(re, im)
  const lpDelay = -Math.atan2(im, re) / w0
  const perPeriod = Math.pow(10, -3 / (p.t60 * p.frequency))
  const g = Math.min(0.99999, perPeriod / lpGain)
  const rest = period - lpDelay
  const n = Math.max(2, Math.floor(rest - 0.5))
  const c = allpassCoefficient(rest - n, w0)

  const length = Math.max(n + 1, Math.round(p.duration * fs))
  const out = new Float32Array(length)
  const ring = excitation(n, p)
  for (let i = 0; i < n && i < length; i++) out[i] = ring[i]
  let lpPrev = 0
  let apIn = 0
  let apOut = 0
  let k = 0
  for (let i = n; i < length; i++) {
    const x = ring[k]
    const lp = g * ((1 - s) * x + s * lpPrev)
    lpPrev = x
    const y = c * lp + apIn - c * apOut
    apIn = lp
    apOut = y
    ring[k] = y
    out[i] = y
    if (++k === n) k = 0
  }

  for (const b of p.body) filterInPlace(out, peakingEq(fs, b.freq, b.q, b.gain))
  if (p.lowpass < fs * 0.45) filterInPlace(out, lowpassBiquad(fs, p.lowpass))

  // loudness: equal RMS over the attack for every string, peaks kept below the ceiling
  const win = Math.min(length, Math.round(0.12 * fs))
  let sum = 0
  let peak = 0
  for (let i = 0; i < length; i++) {
    const v = Math.abs(out[i])
    if (v > peak) peak = v
    if (i < win) sum += out[i] * out[i]
  }
  const rms = Math.sqrt(sum / Math.max(1, win))
  const scale = rms > 0 ? Math.min(TARGET_RMS / rms, PEAK_CEILING / peak) : 0

  // ~1 ms raised-cosine fade-in (no click), raised-cosine fade-out over the last 20%
  const fadeIn = Math.max(1, Math.round(0.001 * fs))
  const fadeOut = Math.max(1, Math.round(length * 0.2))
  for (let i = 0; i < length; i++) {
    let gain = scale
    if (i < fadeIn) gain *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn)
    const left = length - 1 - i
    if (left < fadeOut) gain *= 0.5 - 0.5 * Math.cos((Math.PI * left) / fadeOut)
    out[i] *= gain
  }
  return out
}
