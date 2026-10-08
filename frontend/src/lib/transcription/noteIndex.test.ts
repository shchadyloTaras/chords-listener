import { describe, expect, it } from 'vitest'
import { decodeNotes, encodeNotes, type NoteEvent } from './compact'
import { NoteIndex } from './noteIndex'

function index(events: NoteEvent[]): NoteIndex {
  return new NoteIndex(decodeNotes(encodeNotes(events, 't')))
}

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('NoteIndex', () => {
  const notes: NoteEvent[] = [
    { midi: 60, start: 0, end: 1, velocity: 0.5 },
    { midi: 64, start: 0.5, end: 0.75, velocity: 0.5 },
    { midi: 48, start: 0.2, end: 30, velocity: 0.5 }, // held for half a minute
    { midi: 67, start: 1, end: 1.5, velocity: 0.5 },
    { midi: 72, start: 29.5, end: 31, velocity: 0.5 },
  ]
  const idx = index(notes)
  const midiOf = (list: number[]) => list.map((i) => idx.notes.midi[i]).sort((a, b) => a - b)

  it('finds the notes sounding at a time (start inclusive, end exclusive)', () => {
    expect(midiOf(idx.activeAt(0))).toEqual([60])
    expect(midiOf(idx.activeAt(0.6))).toEqual([48, 60, 64])
    expect(midiOf(idx.activeAt(0.75))).toEqual([48, 60])
    expect(midiOf(idx.activeAt(1))).toEqual([48, 67])
    expect(midiOf(idx.activeAt(17.3))).toEqual([48]) // the long note is found far from its start
    expect(midiOf(idx.activeAt(29.9))).toEqual([48, 72])
    expect(midiOf(idx.activeAt(31))).toEqual([])
    expect(midiOf(idx.activeAt(-1))).toEqual([])
    expect(midiOf(idx.activeAt(Number.NaN))).toEqual([])
  })

  it('finds every note overlapping a window exactly once', () => {
    expect(midiOf(idx.inRange(0.9, 3.9))).toEqual([48, 60, 67])
    expect(midiOf(idx.inRange(1.5, 29.5))).toEqual([48])
    expect(midiOf(idx.inRange(29, 40))).toEqual([48, 72])
    expect(midiOf(idx.inRange(31, 40))).toEqual([])
    expect(midiOf(idx.inRange(2, 2))).toEqual([])
  })

  it('agrees with a brute-force scan on thousands of random notes', () => {
    const r = rng(42)
    const many: NoteEvent[] = Array.from({ length: 4000 }, () => {
      const start = r() * 600
      const len = r() < 0.02 ? r() * 40 : 0.05 + r() * 2
      return { midi: 21 + Math.floor(r() * 88), start, end: start + len, velocity: r() }
    })
    const big = index(many)
    const { start, end } = big.notes
    for (let k = 0; k < 300; k++) {
      const t = r() * 640
      const expected = []
      for (let i = 0; i < big.count; i++) if (start[i] <= t && t < end[i]) expected.push(i)
      expect(big.activeAt(t).sort((a, b) => a - b)).toEqual(expected)
      const t1 = t + r() * 3
      const window = []
      for (let i = 0; i < big.count; i++) if (start[i] < t1 && end[i] > t) window.push(i)
      expect(big.inRange(t, t1).sort((a, b) => a - b)).toEqual(window)
    }
  })

  it('is fast enough for every animation frame', () => {
    const r = rng(7)
    const many: NoteEvent[] = Array.from({ length: 30000 }, (_, i) => {
      const s = i * 0.03
      return { midi: 21 + Math.floor(r() * 88), start: s, end: s + 0.1 + r() * 1.5, velocity: 0.5 }
    })
    const big = index(many)
    const out: number[] = []
    const t0 = performance.now()
    for (let f = 0; f < 6000; f++) {
      const t = (f / 6000) * 900
      big.activeAt(t, out)
      big.inRange(t, t + 3, out)
    }
    // 6000 frames ≈ 100 s of 60 fps rendering
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('reports range and pitch weights', () => {
    expect(idx.minMidi).toBe(48)
    expect(idx.maxMidi).toBe(72)
    const w = idx.pitchWeights()
    expect(w[48]).toBe(4) // long notes are capped so a drone does not dominate the keyboard fit
    expect(w[60]).toBe(1)
    const empty = new NoteIndex(decodeNotes({ version: 1, engine: 'e', notes: [] }))
    expect(empty.activeAt(1)).toEqual([])
    expect(empty.inRange(0, 5)).toEqual([])
    expect(empty.minMidi).toBe(0)
  })

  it('moves the notes into track time for a recording linked to a video (startOffset)', () => {
    const moved = idx.shifted(2070)
    expect(moved.count).toBe(idx.count)
    expect(midiOf(moved.activeAt(2070.6))).toEqual(midiOf(idx.activeAt(0.6)))
    expect(moved.activeAt(0.6)).toEqual([])
    expect(moved.inRange(2099, 2101).map((i) => moved.notes.midi[i]).sort((a, b) => a - b)).toEqual([48, 72])
    expect([moved.minMidi, moved.maxMidi]).toEqual([idx.minMidi, idx.maxMidi])
    // the original is left as it was; no offset is the same index
    expect(idx.notes.start[0]).toBe(0)
    expect(idx.shifted(0)).toBe(idx)
  })
})
