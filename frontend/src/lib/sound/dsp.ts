// Small offline DSP helpers for the chord sound: a seeded PRNG, RBJ biquads and pitch math.
// Pure functions (no Web Audio), so the rendered sounds are deterministic and testable.

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** Equal-tempered frequency, A4 (MIDI 69) = 440 Hz. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** Deterministic PRNG (mulberry32) returning [0, 1): the same seed always renders the same pluck. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Normalized biquad coefficients (a0 = 1). */
export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** RBJ peaking EQ: a resonance (`gainDb` > 0) or a dip around `freq`. */
export function peakingEq(sampleRate: number, freq: number, q: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40)
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  const a0 = 1 + alpha / A
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  }
}

/** RBJ second-order lowpass. */
export function lowpassBiquad(sampleRate: number, freq: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

/** Runs a biquad over `x` in place (direct form I, double-precision state). */
export function filterInPlace(x: Float32Array, f: Biquad): void {
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  const { b0, b1, b2, a1, a2 } = f
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    x[i] = y0
  }
}
