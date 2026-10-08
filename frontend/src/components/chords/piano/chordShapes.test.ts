import { describe, expect, it } from 'vitest'
import { harmoniumVoicing } from '../../../lib/diagrams/harmonium'
import { PIANO_LOW, pianoVoicing } from '../../../lib/diagrams/piano'
import { parseChord } from '../../../lib/music/chord'
import type { DisplayChord } from '../../../lib/music/display'
import { harmoniumShapeNotes, pianoShapeNotes, RESTRIKE_GAP, SHAPE_VELOCITY } from './chordShapes'

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

describe('live piano: the chords as a pianist plays them along', () => {
  const grid = { times: Array.from({ length: 16 }, (_, i) => i * 0.5), pos: Array.from({ length: 16 }, (_, i) => i % 4), meter: 4 }
  const down = (idx: ReturnType<typeof pianoShapeNotes>, t: number) => idx.activeAt(t).map((i) => idx.notes.midi[i]).sort((a, b) => a - b)
  const v = (label: string) => {
    const p = pianoVoicing(parseChord(label)!)
    return [p.bass, ...p.right].map((k) => PIANO_LOW + k).sort((a, b) => a - b)
  }

  it('plays the diagram: the bass in the left hand, the chord in the right, on the beats', () => {
    const idx = pianoShapeNotes([chord(0, 'C', 0, 2), chord(1, 'G', 2, 4)], grid, 0)
    expect(down(idx, 0.1)).toEqual(v('C')) // C3 | C4 E4 G4
    expect(down(idx, 2.1)).toEqual(v('G')) // G2 | B3 D4 G4
  })

  it('re-strikes the right hand on every beat, the bass on beats 1 and 3: a key comes up just before', () => {
    const idx = pianoShapeNotes([chord(0, 'C', 0, 2)], grid, 0)
    const [bass] = v('C')
    expect(down(idx, 0.5 - RESTRIKE_GAP / 2)).toEqual([bass]) // the right hand lifted before beat 2, the bass holds
    expect(down(idx, 0.6)).toEqual(v('C'))
    expect(down(idx, 1 - RESTRIKE_GAP / 2)).toEqual([]) // both hands about to strike beat 3
  })

  it('holds a chord detected a hair after its beat from that beat, the bass included', () => {
    const idx = pianoShapeNotes([chord(0, 'C', 0, 2.04), chord(1, 'G', 2.04, 4)], grid, 0)
    expect(down(idx, 2.2)).toEqual(v('G'))
    expect(down(idx, 2.7)).toEqual(v('G')) // beat 2 of G: the right hand again, the bass still held
  })

  it('in three-four: the bass on 1, held through the bar; the chord on 2 and 3', () => {
    const waltz = { times: Array.from({ length: 6 }, (_, i) => i * 0.5), pos: Array.from({ length: 6 }, (_, i) => i % 3), meter: 3 }
    const idx = pianoShapeNotes([chord(0, 'C', 0, 3)], waltz, 0)
    const [bass] = v('C')
    expect(down(idx, 0.2)).toEqual([bass])
    expect(down(idx, 0.7)).toEqual(v('C'))
    expect(down(idx, 1.2)).toEqual(v('C'))
  })

  it('lifts both hands where there is no chord, and writes transposed labels in the original key', () => {
    const idx = pianoShapeNotes([chord(0, 'C', 0, 2), chord(1, 'N', 2, 3)], grid, 0)
    expect(down(idx, 2.2)).toEqual([])
    const up = pianoShapeNotes([chord(0, 'D', 0, 2)], grid, 2)
    expect(down(up, 0.1).map((m) => m + 2)).toEqual(v('D'))
  })
})
