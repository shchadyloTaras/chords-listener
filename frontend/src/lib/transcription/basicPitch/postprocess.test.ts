import { describe, expect, it } from 'vitest'
// The published reference implementation (devDependency, never bundled): the port must match it.
import { outputToNotesPoly as reference } from '@spotify/basic-pitch/cjs/toMidi.js'
import { outputToNotesPoly, type PolyParams } from './postprocess.ts'

const P = 88

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A posteriorgram that looks like model output: notes with an onset spike and decaying frame
 * activation, harmonics bleeding into neighbours, onset-less sustained notes (melodia trick), noise.
 */
function synthetic(nFrames: number, seed: number) {
  const r = rng(seed)
  const frames = new Float32Array(nFrames * P)
  const onsets = new Float32Array(nFrames * P)
  const add = (arr: Float32Array, row: number, col: number, v: number) => {
    if (row < 0 || row >= nFrames || col < 0 || col >= P) return
    const i = row * P + col
    arr[i] = Math.min(0.999, Math.max(arr[i], v))
  }
  const notes = Math.round(nFrames / 6)
  for (let n = 0; n < notes; n++) {
    const col = Math.floor(r() * P)
    const start = Math.floor(r() * nFrames)
    const len = 3 + Math.floor(r() * 60)
    const peak = 0.35 + r() * 0.6
    const withOnset = r() > 0.2
    for (let k = 0; k < len; k++) {
      const v = peak * Math.exp(-k / (len * 0.8)) + (r() - 0.5) * 0.08
      add(frames, start + k, col, v)
      if (r() > 0.7) add(frames, start + k, col + 12, v * 0.5)
    }
    if (withOnset) {
      add(onsets, start - 1, col, 0.3 + r() * 0.3)
      add(onsets, start, col, 0.4 + r() * 0.59)
      add(onsets, start + 1, col, 0.2 + r() * 0.3)
    }
  }
  for (let i = 0; i < frames.length; i++) {
    if (r() > 0.97) frames[i] = Math.max(frames[i], r() * 0.45)
    if (r() > 0.99) onsets[i] = Math.max(onsets[i], r() * 0.6)
  }
  return { frames, onsets }
}

function rows(a: Float32Array, nFrames: number): number[][] {
  return Array.from({ length: nFrames }, (_, i) => Array.from(a.subarray(i * P, (i + 1) * P)))
}

function runReference(frames: Float32Array, onsets: Float32Array, nFrames: number, p: PolyParams) {
  return reference(
    rows(frames, nFrames),
    rows(onsets, nFrames),
    p.onsetThresh,
    p.frameThresh as number,
    p.minNoteLen,
    p.inferOnsets,
    p.maxFreq,
    p.minFreq,
    p.melodiaTrick,
    p.energyTolerance,
  )
}

const base: PolyParams = {
  onsetThresh: 0.5,
  frameThresh: 0.3,
  minNoteLen: 6,
  inferOnsets: true,
  maxFreq: null,
  minFreq: null,
  melodiaTrick: true,
  energyTolerance: 11,
}

describe('outputToNotesPoly port', () => {
  const cases: Array<[string, number, number, Partial<PolyParams>]> = [
    ['defaults used by the app', 900, 1, {}],
    ['reference defaults', 700, 2, { minNoteLen: 5 }],
    ['no melodia trick', 800, 3, { melodiaTrick: false }],
    ['no inferred onsets', 800, 4, { inferOnsets: false }],
    ['adaptive frame threshold', 600, 5, { frameThresh: null }],
    ['frequency bounds', 600, 6, { minFreq: 60, maxFreq: 1500 }],
    ['looser thresholds', 1200, 7, { onsetThresh: 0.3, frameThresh: 0.2, minNoteLen: 3 }],
  ]
  for (const [name, nFrames, seed, over] of cases) {
    it(`matches the published implementation: ${name}`, () => {
      const p = { ...base, ...over }
      const { frames, onsets } = synthetic(nFrames, seed)
      const ours = outputToNotesPoly(frames, onsets, nFrames, p)
      const theirs = runReference(frames, onsets, nFrames, p)
      expect(ours.length).toBeGreaterThan(10)
      expect(ours.map(({ startFrame, durationFrames, pitchMidi }) => [startFrame, durationFrames, pitchMidi])).toEqual(
        theirs.map(({ startFrame, durationFrames, pitchMidi }) => [startFrame, durationFrames, pitchMidi]),
      )
      ours.forEach((n, i) => expect(n.amplitude).toBeCloseTo(theirs[i].amplitude, 12))
      // melodia notes are flagged
      if (p.melodiaTrick) expect(ours.some((n) => !n.fromOnset)).toBe(true)
    })
  }

  it('does not modify its inputs and handles silence and tiny inputs', () => {
    const { frames, onsets } = synthetic(300, 9)
    const f0 = frames.slice()
    const o0 = onsets.slice()
    outputToNotesPoly(frames, onsets, 300, { ...base, minFreq: 100 })
    expect(frames).toEqual(f0)
    expect(onsets).toEqual(o0)
    expect(outputToNotesPoly(new Float32Array(50 * P), new Float32Array(50 * P), 50)).toEqual([])
    expect(outputToNotesPoly(new Float32Array(P), new Float32Array(P), 1)).toEqual([])
    expect(outputToNotesPoly(new Float32Array(0), new Float32Array(0), 0)).toEqual([])
  })

  it('stays fast on a whole song', () => {
    // ~6 minutes of frames; the reference needs tens of seconds here (rescans per melodia note)
    const nFrames = 31_000
    const { frames, onsets } = synthetic(nFrames, 11)
    const t0 = performance.now()
    const notes = outputToNotesPoly(frames, onsets, nFrames, base)
    const ms = performance.now() - t0
    expect(notes.length).toBeGreaterThan(1000)
    expect(ms).toBeLessThan(3000)
  })
})
