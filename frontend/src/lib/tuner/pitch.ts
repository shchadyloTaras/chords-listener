// Pitch of a monophonic frame by the McLeod Pitch Method (McLeod & Wyvill, "A smarter way to find
// pitch", 2005): the normalized square difference function (NSDF) from an FFT autocorrelation, the
// first "key maximum" close to the highest one, refined by a parabola through its neighbours.

import { RealFFT } from '../engine/core/fft'

export interface PitchEstimate {
  hz: number
  /** height of the chosen NSDF peak, 0..1 (1 = perfectly periodic) */
  clarity: number
}

/** detection range: below the lowest 5-string bass note (B0 ≈ 30.9 Hz) to above a violin's E7 */
export const MIN_HZ = 25
export const MAX_HZ = 2100
/** the first key maximum at least this share of the highest one wins (lower = more octave-down errors) */
const KEY_SHARE = 0.9
/** weaker peaks are noise, not a pitch */
const MIN_CLARITY = 0.5

export interface PitchDetector {
  /** frame length the detector was built for (the frame may be shorter, never longer) */
  readonly size: number
  detect(frame: Float32Array, sampleRate: number): PitchEstimate | null
}

/** Buffers are allocated once: one detector serves every frame of a session. */
export function createPitchDetector(size: number): PitchDetector {
  const n = size * 2 // zero-padded: the circular autocorrelation equals the linear one for lags < size
  const fft = new RealFFT(n)
  const padded = new Float64Array(n)
  const power = new Float64Array(n)
  const re = new Float64Array(n / 2 + 1)
  const im = new Float64Array(n / 2 + 1)
  const nsdf = new Float64Array(size)

  function detect(frame: Float32Array, sampleRate: number): PitchEstimate | null {
    const w = Math.min(frame.length, size)
    // autocorrelation r(τ) = IFFT(|X|²); |X|² is real and even, so its forward FFT is n·r(τ)
    padded.fill(0)
    for (let i = 0; i < w; i++) padded[i] = frame[i]
    fft.forward(padded, re, im)
    for (let k = 0; k <= n / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      power[k] = p
      if (k > 0 && k < n / 2) power[n - k] = p
    }
    fft.forward(power, re, im)

    // NSDF n(τ) = 2 r(τ) / m(τ), m(τ) = Σ x[j]² + x[j+τ]² over the overlap, updated lag by lag
    const limit = w - 2
    let m = 0
    for (let i = 0; i < w; i++) m += 2 * frame[i] * frame[i]
    if (m <= 1e-12) return null
    for (let tau = 0; tau <= limit + 1; tau++) {
      if (tau > 0) m -= frame[tau - 1] * frame[tau - 1] + frame[w - tau] * frame[w - tau]
      nsdf[tau] = m > 1e-12 ? (2 * re[tau]) / n / m : 0
    }

    // key maxima: the highest point of each positive lobe after the first negative-going zero crossing
    const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ))
    const maxLag = Math.min(limit, Math.ceil(sampleRate / MIN_HZ))
    const peaks: number[] = []
    let tau = 1
    while (tau <= limit && nsdf[tau] > 0) tau++
    while (tau <= limit) {
      while (tau <= limit && nsdf[tau] <= 0) tau++
      let peak = -1
      while (tau <= limit && nsdf[tau] > 0) {
        if (peak < 0 || nsdf[tau] > nsdf[peak]) peak = tau
        tau++
      }
      if (peak < 0 || peak > maxLag || tau > limit) break
      peaks.push(peak)
    }
    if (!peaks.length) return null
    let highest = 0
    for (const p of peaks) highest = Math.max(highest, nsdf[p])
    const best = peaks.find((p) => nsdf[p] >= KEY_SHARE * highest)!
    // a period shorter than MAX_HZ allows: out of range (not its octave below)
    if (best < minLag) return null

    // parabola through the peak and its neighbours: sub-sample lag and height
    const a = nsdf[best - 1]
    const b = nsdf[best]
    const c = nsdf[best + 1]
    const den = a - 2 * b + c
    const shift = den < 0 ? (0.5 * (a - c)) / den : 0
    const clarity = Math.min(1, b - 0.25 * (a - c) * shift)
    if (clarity < MIN_CLARITY) return null
    return { hz: sampleRate / (best + shift), clarity }
  }

  return { size, detect }
}
