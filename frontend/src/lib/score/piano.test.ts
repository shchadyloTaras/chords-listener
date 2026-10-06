import { describe, expect, it } from 'vitest'
import { demoSong, steadyBars } from './__fixtures__/song'
import { arrangePiano, capChord, chordPiano, PIANO, splitPoints } from './piano'
import { buildTimeMap, DIV } from './timeMap'
import type { ScoreNote } from './types'
import type { NoteRow } from './vocal'

// 120 BPM: a beat = 0.5 s
const map = buildTimeMap(steadyBars({ bpm: 120, bars: 8 }).bars, 4)
const at = (beat: number, beats: number, midis: number[], v = 0.8): NoteRow[] => midis.map((m) => [beat * 0.5 + 0.01, (beat + beats) * 0.5 - 0.01, m, v])
const pitches = (ns: ScoreNote[]) => ns.map((n) => n.pitches)

describe('hand split', () => {
  it('puts a bass note in the left hand and the chord above it in the right hand', () => {
    // E2 + G3 B3 D4: a fixed split at middle C would give the left hand E2 G3 B3 (19 semitones)
    const { rh, lh } = arrangePiano(at(0, 1, [40, 55, 59, 62]), map, { step: 1 })
    expect(pitches(lh)).toEqual([[40]])
    expect(pitches(rh)).toEqual([[55, 59, 62]])
  })

  it('splits a wide voicing at middle C', () => {
    const { rh, lh } = arrangePiano(at(0, 1, [48, 52, 55, 60, 64, 67]), map, { step: 1 })
    expect(pitches(lh)).toEqual([[48, 52, 55]])
    expect(pitches(rh)).toEqual([[60, 64, 67]])
  })

  it('keeps a melody that dips below middle C in one hand', () => {
    const rows = [...at(0, 4, [43]), ...at(0, 1, [62]), ...at(1, 1, [60]), ...at(2, 1, [59]), ...at(3, 1, [57]), ...at(4, 4, [48]), ...at(4, 1, [60])]
    const { rh, lh } = arrangePiano(rows, map, { step: 1 })
    expect(pitches(rh)).toEqual([[62], [60], [59], [57], [60]])
    expect(pitches(lh)).toEqual([[43], [48]])
  })

  it('keeps low clusters in the bass clef', () => {
    const { rh, lh } = arrangePiano(at(0, 2, [43, 47, 50, 53]), map, { step: 1 })
    expect(rh).toEqual([])
    expect(pitches(lh)).toEqual([[43, 47, 50, 53]])
  })

  it('moves smoothly (no jitter between neighbouring beats)', () => {
    const notes = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((b) => [
      { midi: 45, qs: b * DIV },
      { midi: b % 2 ? 59 : 64, qs: b * DIV },
    ])
    const splits = splitPoints(notes, 8)
    expect(new Set(splits).size).toBe(1)
    expect(splits[0]).toBeGreaterThan(45)
    expect(splits[0]).toBeLessThanOrEqual(59)
  })
})

describe('arrangePiano', () => {
  it('writes notes with the same onset as a chord lasting until the next onset of that hand', () => {
    const rows = [...at(0, 4, [64, 67]), ...at(1, 1, [72])]
    const { rh } = arrangePiano(rows, map, { step: 1 })
    expect(rh.map((n) => [n.start, n.end, n.pitches])).toEqual([
      [0, 4, [64, 67]],
      [4, 8, [72]],
    ])
  })

  it('a chord lasts as long as its longest note when the hand is silent afterwards', () => {
    const rows = [...at(0, 2, [64]), ...at(0, 3, [67])]
    const { rh } = arrangePiano(rows, map, { step: 1 })
    expect(rh.map((n) => [n.start, n.end])).toEqual([[0, 12]])
  })

  it('caps a hand at 4 notes and keeps the outer voices', () => {
    expect(capChord([60, 62, 64, 65, 67, 72].map((midi, i) => ({ midi, velocity: [0.9, 0.3, 0.8, 0.2, 0.7, 0.6][i] })), 4).map((n) => n.midi)).toEqual([
      60, 64, 67, 72,
    ])
    const { rh } = arrangePiano(at(0, 1, [60, 62, 64, 65, 67, 72]), map, { step: 1 })
    expect(rh[0].pitches).toHaveLength(PIANO.maxNotes)
    expect(rh[0].pitches[0]).toBe(60)
    expect(rh[0].pitches[3]).toBe(72)
  })

  it('drops ghost notes: quiet, very short, or weak next to a loud chord', () => {
    const rows: NoteRow[] = [
      ...at(0, 1, [64], 0.9),
      [0.01, 0.06, 76, 0.9], // 50 ms blip
      ...at(1, 1, [65], 0.2), // quiet
      ...at(2, 1, [67], 0.9),
      ...at(2, 1, [79], 0.32), // overtone: weaker than 40 % of the chord's loudest note
    ]
    const { rh } = arrangePiano(rows, map, { step: 1 })
    expect(pitches(rh)).toEqual([[64], [67]])
  })

  it('removes the singer from a full-mix transcription', () => {
    const vocals: NoteRow[] = [[0, 1, 69, 0.8]]
    const rows = [...at(0, 2, [69]), ...at(0, 2, [57, 64])]
    const kept = arrangePiano(rows, map, { step: 1, vocals })
    expect(kept.rh.flatMap((n) => n.pitches)).not.toContain(69)
    expect(kept.rh.flatMap((n) => n.pitches)).toContain(64)
    const all = arrangePiano(rows, map, { step: 1 })
    expect(all.rh.flatMap((n) => n.pitches)).toContain(69)
  })

  it('writes the lowest bass notes an octave higher', () => {
    const { lh } = arrangePiano([...at(0, 1, [29]), ...at(1, 1, [33]), ...at(2, 1, [24, 36])], map, { step: 1 })
    expect(pitches(lh)).toEqual([[41], [33], [36]])
    const simple = arrangePiano(at(0, 1, [33]), map, { step: 2, simplified: true })
    expect(pitches(simple.lh)).toEqual([[45]])
  })

  it('transposes', () => {
    const { rh, lh } = arrangePiano(at(0, 1, [40, 72, 76]), map, { step: 1, transpose: -3 })
    expect(rh[0].pitches).toEqual([69, 73])
    expect(lh[0].pitches).toEqual([37])
  })

  it('simplified (the medium level): eighth grid, thinner hands, repeated chords held', () => {
    const rows = [
      ...at(0, 0.5, [43, 50, 55]),
      ...at(0.5, 0.5, [43, 50, 55]),
      ...at(0, 0.25, [62, 67, 71, 74]),
      ...at(0.25, 0.25, [62, 67, 71, 74]),
    ]
    const { rh, lh } = arrangePiano(rows, map, { step: 2, simplified: true })
    for (const n of [...rh, ...lh]) {
      expect(n.start % 2).toBe(0)
      expect(n.end % 2).toBe(0)
    }
    expect(Math.max(...rh.map((n) => n.pitches.length))).toBeLessThanOrEqual(PIANO.maxNotesRhSimple)
    expect(Math.max(...lh.map((n) => n.pitches.length))).toBeLessThanOrEqual(PIANO.maxNotesLhSimple)
    // the left hand's chord struck twice within the beat is held instead
    expect(lh).toHaveLength(1)
    expect(lh[0].end - lh[0].start).toBe(DIV)
  })

  it('arranges the demo song readably', () => {
    const song = demoSong()
    const m = buildTimeMap(song.bars, 4)
    const { rh, lh } = arrangePiano(song.piano, m, { step: 1 })
    // bass notes in the left hand, chords in the right hand
    expect(lh.map((n) => n.pitches)).toEqual([[45], [41], [48], [43]])
    expect(rh.every((n) => n.pitches.length >= 3 && n.pitches.length <= 4)).toBe(true)
    expect(rh[0].pitches).toEqual([57, 60, 64])
  })
})

describe('chordPiano (the simple level)', () => {
  /** bars of a steady song with these chords ([label, start beat, beats]) and their measures */
  const sheet = (chords: [string, number, number][], bars: number, ts = 4) => {
    const song = steadyBars({ bpm: 120, bars, ts, chords })
    return { bars: song.bars, measures: buildTimeMap(song.bars, ts).measures }
  }
  const strikes = (ns: ScoreNote[]) => ns.map((n) => [n.start, n.end, n.pitches])
  const slot = (label: string, beat: number, span: number) => ({ label, isNone: label === 'N', beat, span })

  it('a chord over a 4/4 bar is one whole note: the diagram voicing in the right hand, the root below middle C in the left', () => {
    const { bars, measures } = sheet([['C', 0, 4]], 1)
    const { rh, lh } = chordPiano(bars, measures)
    expect(strikes(rh)).toEqual([[0, 16, [60, 64, 67]]])
    expect(strikes(lh)).toEqual([[0, 16, [48]]])
    expect(rh[0].velocity).toBe(PIANO.chordVelocity)
  })

  it('two chords in a bar are two halves', () => {
    const { bars, measures } = sheet([['C', 0, 2], ['G', 2, 2]], 1)
    const { rh, lh } = chordPiano(bars, measures)
    expect(strikes(rh)).toEqual([
      [0, 8, [60, 64, 67]],
      [8, 16, [67, 71, 74]],
    ])
    expect(strikes(lh)).toEqual([
      [0, 8, [48]],
      [8, 16, [55]],
    ])
  })

  it('a chord over two bars is struck again at the second barline (no tie)', () => {
    const { bars, measures } = sheet([['Am', 0, 8]], 2)
    const { rh, lh } = chordPiano(bars, measures)
    expect(strikes(rh)).toEqual([
      [0, 16, [69, 72, 76]],
      [16, 32, [69, 72, 76]],
    ])
    expect(strikes(lh)).toEqual([
      [0, 16, [57]],
      [16, 32, [57]],
    ])
  })

  it('no chord (N) and unknown labels are rests', () => {
    const { bars, measures } = sheet([['C', 4, 4]], 2)
    expect(bars[0].slots.map((s) => s.isNone)).toEqual([true])
    expect(strikes(chordPiano(bars, measures).rh)).toEqual([[16, 32, [60, 64, 67]]])
    const odd = [{ slots: [slot('C', 0, 1), slot('N', 1, 1), slot('???', 2, 1), slot('F', 3, 1)] }]
    const { rh, lh } = chordPiano(odd, measures)
    expect(strikes(rh)).toEqual([
      [0, 4, [60, 64, 67]],
      [12, 16, [65, 69, 72]],
    ])
    expect(strikes(lh)).toEqual([
      [0, 4, [48]],
      [12, 16, [53]],
    ])
  })

  it('merges the same chord repeated inside a bar', () => {
    const { measures } = sheet([], 1)
    const { rh } = chordPiano([{ slots: [slot('D', 0, 2), slot('D', 2, 2)] }], measures)
    expect(strikes(rh)).toEqual([[0, 16, [62, 66, 69]]])
  })

  it('a slash chord: the bass in the left hand, the chord above it without the bass key', () => {
    const { bars, measures } = sheet([['C/G', 0, 4]], 1)
    const { rh, lh } = chordPiano(bars, measures)
    expect(strikes(rh)).toEqual([[0, 16, [72, 76, 79]]])
    expect(strikes(lh)).toEqual([[0, 16, [55]]])
  })

  it('flat and sharp roots', () => {
    const { measures } = sheet([], 1)
    const bb = chordPiano([{ slots: [slot('Bb', 0, 2), slot('F#m', 2, 2)] }], measures)
    expect(strikes(bb.rh)).toEqual([
      [0, 8, [70, 74, 77]],
      [8, 16, [66, 69, 73]],
    ])
    expect(strikes(bb.lh)).toEqual([
      [0, 8, [58]],
      [8, 16, [54]],
    ])
  })

  it('a 3/4 bar is a dotted half', () => {
    const { bars, measures } = sheet([['D', 0, 3], ['Em', 3, 3]], 2, 3)
    const { rh, lh } = chordPiano(bars, measures)
    expect(strikes(rh)).toEqual([
      [0, 12, [62, 66, 69]],
      [12, 24, [64, 67, 71]],
    ])
    expect(strikes(lh)).toEqual([
      [0, 12, [50]],
      [12, 24, [52]],
    ])
  })

  it('nothing for a sheet without chords', () => {
    const { bars, measures } = sheet([], 2)
    expect(chordPiano(bars, measures)).toEqual({ rh: [], lh: [] })
  })
})
