// The tuner's pitch detector on synthetic frames: sines across the range at both common sample rates,
// tones rich in overtones (no octave errors), a detuned note, a plucked note, and frames with no pitch.
import { describe, expect, it } from 'vitest'
import { addTone, rng } from '../engine/testing/synth'
import { createPitchDetector } from './pitch'

const SIZE = 4096
const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref)

/** sum of sines k·hz with amplitudes amps[k-1] */
function partials(hz: number, sr: number, amps: number[]): Float32Array {
  const x = new Float32Array(SIZE)
  amps.forEach((a, k) => {
    const w = (2 * Math.PI * hz * (k + 1)) / sr
    for (let i = 0; i < SIZE; i++) x[i] += a * Math.sin(w * i + 0.3 + k)
  })
  return x
}

const detector = createPitchDetector(SIZE)

describe('createPitchDetector', () => {
  for (const sr of [44100, 48000]) {
    for (const hz of [27.5, 41.2, 82.41, 110, 196, 440, 1318.5, 2000]) {
      it(`a ${hz} Hz sine at ${sr} Hz is within 1 cent`, () => {
        const r = detector.detect(partials(hz, sr, [0.5]), sr)
        expect(r).not.toBeNull()
        expect(Math.abs(cents(r!.hz, hz))).toBeLessThan(1)
        expect(r!.clarity).toBeGreaterThan(0.99)
      })
    }
  }

  it('a sawtooth (every overtone) is not read an octave off', () => {
    const r = detector.detect(partials(82.41, 48000, Array.from({ length: 20 }, (_, k) => 0.3 / (k + 1))), 48000)
    expect(Math.abs(cents(r!.hz, 82.41))).toBeLessThan(1)
  })

  it('a fundamental weaker than its 2nd harmonic is still the pitch', () => {
    const r = detector.detect(partials(82.41, 48000, [0.15, 0.3, 0.2, 0.1, 0.05]), 48000)
    expect(Math.abs(cents(r!.hz, 82.41))).toBeLessThan(1)
  })

  it('measures a detuned note: A2 + 12 cents', () => {
    const r = detector.detect(partials(110 * 2 ** (12 / 1200), 48000, [0.5, 0.25]), 48000)
    expect(cents(r!.hz, 110)).toBeCloseTo(12, 0)
  })

  it('a plucked E2 (+12 cents) 50 ms after the attack is within 1 cent', () => {
    const sr = 48000
    const audio = new Float32Array(sr)
    addTone(audio, sr, 40, 0, 1, { amp: 0.4, partials: 8, cents: 12 })
    const noise = rng(3)
    for (let i = 0; i < audio.length; i++) audio[i] += 0.003 * (2 * noise() - 1)
    const at = Math.round(0.05 * sr)
    const r = detector.detect(audio.subarray(at, at + SIZE), sr)
    expect(cents(r!.hz, 82.40689) - 12).toBeLessThan(1)
    expect(cents(r!.hz, 82.40689) - 12).toBeGreaterThan(-1)
  })

  it('silence, noise and pitches out of range give nothing', () => {
    expect(detector.detect(new Float32Array(SIZE), 48000)).toBeNull()
    const noise = rng(9)
    expect(detector.detect(Float32Array.from({ length: SIZE }, () => noise() - 0.5), 48000)).toBeNull()
    expect(detector.detect(partials(3000, 48000, [0.5]), 48000)).toBeNull()
    expect(detector.detect(partials(20, 48000, [0.5]), 48000)).toBeNull()
  })

  it('accepts a frame shorter than its size', () => {
    const r = detector.detect(partials(440, 48000, [0.5]).subarray(0, 2048), 48000)
    expect(Math.abs(cents(r!.hz, 440))).toBeLessThan(1)
  })
})
