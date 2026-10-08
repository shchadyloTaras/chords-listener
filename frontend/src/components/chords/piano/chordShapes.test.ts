import { describe, expect, it } from 'vitest'
import { harmoniumVoicing } from '../../../lib/diagrams/harmonium'
import { parseChord } from '../../../lib/music/chord'
import type { DisplayChord } from '../../../lib/music/display'
import { harmoniumShapeNotes, SHAPE_VELOCITY } from './chordShapes'

const chord = (index: number, label: string, start: number, end: number): DisplayChord => {
  const p = label === 'N' ? null : parseChord(label)
  return { index, start, end, label, rootPc: p?.rootPc ?? null, quality: p?.quality ?? null, bassPc: p?.bassPc ?? null, isNone: !p, confidence: 1, srcStart: index, srcEnd: index }
}
const song = [chord(0, 'C', 0, 2), chord(1, 'F', 2, 4), chord(2, 'N', 4, 5), chord(3, 'G7', 5, 6.5)]
const sounding = (idx: ReturnType<typeof harmoniumShapeNotes>, t: number) => idx.activeAt(t).map((i) => idx.notes.midi[i]).sort((a, b) => a - b)

describe('live harmonium: held chord shapes', () => {
  it('holds each chord’s diagram shape from its start until the chord changes', () => {
    const idx = harmoniumShapeNotes(song, 0)
    expect(sounding(idx, 0)).toEqual([60, 64, 67]) // C E G
    expect(sounding(idx, 1.99)).toEqual([60, 64, 67]) // still held on the count
    expect(sounding(idx, 2)).toEqual([60, 65, 69]) // F = C F A, pressed when the chord changes
    expect(sounding(idx, 4.5)).toEqual([]) // no chord: hands off
    expect(sounding(idx, 6)).toEqual(harmoniumVoicing(parseChord('G7')!).notes.map((k) => 48 + k))
    for (let i = 0; i < idx.count; i++) expect(idx.notes.velocity[i]).toBeCloseTo(SHAPE_VELOCITY, 6)
  })

  it('writes transposed labels in the original key: the panel transposes song notes itself', () => {
    const idx = harmoniumShapeNotes([chord(0, 'D', 0, 2)], 2) // C transposed +2
    expect(sounding(idx, 1).map((m) => m + 2)).toEqual(harmoniumVoicing(parseChord('D')!).notes.map((k) => 48 + k))
  })
})
