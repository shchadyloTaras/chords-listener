import { describe, expect, it } from 'vitest'
import { chordSymbolsFromBars, harmonyOf } from './chordSymbols'
import { steadyBars } from './__fixtures__/song'
import { fromFifths, keyAlter, keySigName, keySignature, midiOf, spellMidi, spellPc } from './spelling'
import { buildTimeMap } from './timeMap'

const key = (tonic: string, mode: 'major' | 'minor' = 'major') => ({ tonic, mode, name: tonic + (mode === 'minor' ? 'm' : '') })
const names = (pcs: number[], k: ReturnType<typeof keySignature>) =>
  pcs.map((pc) => {
    const s = spellPc(pc, k)
    return s.step + (s.alter > 0 ? '#'.repeat(s.alter) : 'b'.repeat(-s.alter))
  })

describe('key signatures', () => {
  it('follows the transposed key', () => {
    expect(keySignature(key('C'), 0)).toMatchObject({ fifths: 0, mode: 'major', known: true })
    expect(keySignature(key('A', 'minor'), 0).fifths).toBe(0)
    expect(keySignature(key('F'), 0).fifths).toBe(-1)
    expect(keySignature(key('C'), 2).fifths).toBe(2) // D major
    expect(keySignature(key('A', 'minor'), -2).fifths).toBe(-2) // G minor
    expect(keySignature(key('D#'), 0).fifths).toBe(-3) // detected "D#" major is written E♭
    expect(keySignature(key('G#', 'minor'), 0).fifths).toBe(5)
    expect(keySignature(key('C#'), 0).fifths).toBe(-5) // D♭
  })

  it('F♯ / G♭ follow the spelling preference', () => {
    expect(keySignature(key('F#'), 0, 'auto').fifths).toBe(-6)
    expect(keySignature(key('F#'), 0, 'sharp').fifths).toBe(6)
    expect(keySignature(key('D#', 'minor'), 0, 'sharp').fifths).toBe(6)
  })

  it('without a key: C major, chromatic notes by preference', () => {
    expect(keySignature(null, 3)).toMatchObject({ fifths: 0, known: false })
    expect(names([1, 3, 6, 8, 10], keySignature(null, 0, 'flat'))).toEqual(['Db', 'Eb', 'Gb', 'Ab', 'Bb'])
    expect(names([1, 3, 6, 8, 10], keySignature(null, 0, 'sharp'))).toEqual(['C#', 'D#', 'F#', 'G#', 'A#'])
  })

  it('names the key', () => {
    expect(keySigName(keySignature(key('D#'), 0))).toBe('Eb')
    expect(keySigName(keySignature(key('C', 'minor'), 0))).toBe('Cm')
  })
})

describe('note spelling', () => {
  it('diatonic notes as in the key', () => {
    expect(names([0, 2, 4, 5, 7, 9, 11], keySignature(key('C'), 0))).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'])
    expect(names([10, 0, 2, 3, 5, 7, 9], keySignature(key('A#'), 0))).toEqual(['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A'])
    expect(names([4, 6, 8, 9, 11, 1, 3], keySignature(key('E'), 0))).toEqual(['E', 'F#', 'G#', 'A', 'B', 'C#', 'D#'])
  })

  it('chromatic notes lean to the key; the minor leading tone is raised', () => {
    // C major: C♯ E♭ F♯ G♯ B♭
    expect(names([1, 3, 6, 8, 10], keySignature(key('C'), 0))).toEqual(['C#', 'Eb', 'F#', 'G#', 'Bb'])
    // A minor: G♯ (leading tone), F♯ (melodic minor)
    expect(names([8, 6], keySignature(key('A', 'minor'), 0))).toEqual(['G#', 'F#'])
    // D minor: C♯, B♭
    expect(names([1, 10], keySignature(key('D', 'minor'), 0))).toEqual(['C#', 'Bb'])
    // E♭ major blue notes: G♭ (♭3), D♭ (♭7)
    expect(names([6, 1], keySignature(key('D#'), 0))).toEqual(['Gb', 'Db'])
  })

  it('octaves follow the written letter', () => {
    const k = keySignature(key('F#'), 0, 'sharp') // 6 sharps: E♯
    expect(spellMidi(65, k)).toEqual({ step: 'E', alter: 1, octave: 4 })
    const cb = keySignature(key('B'), 0) // B major, spelled with sharps
    expect(spellMidi(59, cb)).toEqual({ step: 'B', alter: 0, octave: 3 })
    for (let m = 21; m <= 108; m++) expect(midiOf(spellMidi(m, keySignature(key('G#', 'minor'), 0)))).toBe(m)
  })

  it('key alterations by letter', () => {
    expect(keyAlter('F', 2)).toBe(1)
    expect(keyAlter('C', 2)).toBe(1)
    expect(keyAlter('G', 2)).toBe(0)
    expect(keyAlter('B', -1)).toBe(-1)
    expect(keyAlter('E', -1)).toBe(0)
    expect(fromFifths(-8)).toEqual({ step: 'F', alter: -1 })
  })
})

describe('chord symbols', () => {
  it('writes chord changes on the beat from the sheet, transposed and spelled for display', () => {
    const song = steadyBars({ bpm: 120, bars: 3, chords: [['A#', 0, 4], ['Gm7', 4, 2], ['F/A', 6, 2], ['N', 8, 4]], spelling: 'flat', transpose: 0 })
    const map = buildTimeMap(song.bars, 4)
    expect(chordSymbolsFromBars(song.bars, map.measures)).toEqual([
      { tick: 0, label: 'Bb' },
      { tick: 16, label: 'Gm7' },
      { tick: 24, label: 'F/A' },
      { tick: 32, label: 'N' },
    ])
  })

  it('MusicXML harmony for every quality', () => {
    expect(harmonyOf('Bbm7/F')).toEqual({
      root: { step: 'B', alter: -1 },
      kind: 'minor-seventh',
      text: 'm7',
      bass: { step: 'F', alter: 0 },
      degrees: [],
    })
    expect(harmonyOf('C#m7b5')).toMatchObject({ root: { step: 'C', alter: 1 }, kind: 'half-diminished' })
    expect(harmonyOf('Dadd9')).toMatchObject({ kind: 'major', text: '', degrees: [{ value: 9, alter: 0, type: 'add' }] })
    expect(harmonyOf('E6')?.kind).toBe('major-sixth')
    expect(harmonyOf('N')).toBeNull()
  })
})
