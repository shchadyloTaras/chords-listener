import { describe, expect, it } from 'vitest'
import { addTone } from '../testing/synth.ts'
import { chromaProbabilities, parseLabel, formatLabel, chordFields } from './chords.ts'
import { SR, chromaFeatures, estimateTuning, frameCount } from './spectrum.ts'

function meanChroma(x: Float32Array, T: number, from = 0, to = T): number[] {
  const m = new Array<number>(12).fill(0)
  for (let t = from; t < to; t++) for (let i = 0; i < 12; i++) m[i] += x[t * 12 + i]
  return m.map((v) => v / Math.max(1, to - from))
}

const top = (m: number[], k: number) => m.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, k).map(([, i]) => i).sort((a, b) => a - b)

describe('chroma features', () => {
  it('finds the three pitch classes of a C major triad, and its bass', () => {
    const y = new Float32Array(3 * SR)
    for (const m of [60, 64, 67]) addTone(y, SR, m, 0.05, 2.9, { amp: 0.15, decay: 3 }) // C4 E4 G4
    addTone(y, SR, 36, 0.05, 2.9, { amp: 0.3, partials: 4, decay: 3 }) // C2
    const f = chromaFeatures(y, 0)
    expect(f.T).toBe(frameCount(y.length))
    const mid = [Math.round(0.5 * f.fps), Math.round(2.5 * f.fps)] as const
    const treble = meanChroma(f.treble, f.T, ...mid)
    expect(top(treble, 3)).toEqual([0, 4, 7])
    const bass = meanChroma(f.bass, f.T, ...mid)
    expect(bass.indexOf(Math.max(...bass))).toBe(0)
    // presence probabilities: chord tones clearly above the rest
    const p = chromaProbabilities(Float32Array.from(treble), 1)
    for (const pc of [0, 4, 7]) expect(p[pc]).toBeGreaterThan(0.8)
    for (const pc of [1, 3, 6, 8, 10]) expect(p[pc]).toBeLessThan(0.3)
  })

  it('tells A minor from A major', () => {
    const minor = new Float32Array(2 * SR)
    for (const m of [57, 60, 64]) addTone(minor, SR, m, 0, 2, { decay: 3 })
    const major = new Float32Array(2 * SR)
    for (const m of [57, 61, 64]) addTone(major, SR, m, 0, 2, { decay: 3 })
    const cm = meanChroma(chromaFeatures(minor, 0).treble, frameCount(minor.length))
    const cM = meanChroma(chromaFeatures(major, 0).treble, frameCount(major.length))
    expect(top(cm, 3)).toEqual([0, 4, 9])
    expect(top(cM, 3)).toEqual([1, 4, 9])
  })

  it('estimates a detuned reference pitch', () => {
    const y = new Float32Array(4 * SR)
    // +30 cents, a few notes so that there are enough peaks
    const notes = [57, 60, 64, 67, 69, 72]
    notes.forEach((m, i) => addTone(y, SR, m, (i * 4) / notes.length, 1.5, { cents: 30, decay: 2 }))
    expect(estimateTuning(y)).toBeCloseTo(0.3, 1)
    const inTune = new Float32Array(4 * SR)
    notes.forEach((m, i) => addTone(inTune, SR, m, (i * 4) / notes.length, 1.5, { decay: 2 }))
    expect(Math.abs(estimateTuning(inTune))).toBeLessThan(0.05)
  })
})

describe('chord labels', () => {
  it('formats with sharps and parses flats', () => {
    expect(formatLabel(1, 'min')).toBe('C#m')
    expect(formatLabel(7, 'maj', 11)).toBe('G/B')
    expect(formatLabel(null, null)).toBe('N')
    expect(parseLabel('Bbmaj7/D')).toEqual({ root: 10, quality: 'maj7', bass: 2 })
    expect(parseLabel('N')).toEqual({ root: null, quality: null, bass: null })
    expect(chordFields(parseLabel('F#m7b5'))).toEqual({ label: 'F#m7b5', root: 'F#', quality: 'hdim7', bass: null })
    expect(() => parseLabel('Cxyz')).toThrow()
  })
})
