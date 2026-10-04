import { describe, expect, it } from 'vitest'
import {
  chordPitchClasses,
  formatChord,
  normalizeChord,
  parseChord,
  simplifyChord,
  splitLabel,
  transposeChord,
} from './chord'
import { noteToPc, pcToName, readNote } from './notes'

describe('notes', () => {
  it('reads note names with accidentals', () => {
    expect(readNote('C#m7')).toEqual({ pc: 1, name: 'C#', length: 2 })
    expect(readNote('Ebmaj7')).toEqual({ pc: 3, name: 'Eb', length: 2 })
    expect(readNote('Bbm')).toEqual({ pc: 10, name: 'Bb', length: 2 })
    expect(readNote('am')).toEqual({ pc: 9, name: 'A', length: 1 })
    expect(readNote('H')).toBeNull()
    expect(noteToPc('Cb')).toBe(11)
    expect(noteToPc('E#')).toBe(5)
    expect(noteToPc('F♯')).toBe(6)
    expect(noteToPc('X')).toBeNull()
    expect(pcToName(10, 'flat')).toBe('Bb')
    expect(pcToName(-2, 'sharp')).toBe('A#')
  })
})

describe('parseChord', () => {
  it('parses the SPEC convention', () => {
    expect(parseChord('C')).toMatchObject({ root: 'C', rootPc: 0, quality: 'maj', suffix: '', bass: null })
    expect(parseChord('C#m7')).toMatchObject({ root: 'C#', rootPc: 1, quality: 'min7', suffix: 'm7' })
    expect(parseChord('Ebmaj7')).toMatchObject({ root: 'Eb', rootPc: 3, quality: 'maj7' })
    expect(parseChord('F/A')).toMatchObject({ root: 'F', quality: 'maj', bass: 'A', bassPc: 9 })
    expect(parseChord('Am7b5')).toMatchObject({ rootPc: 9, quality: 'hdim7', suffix: 'm7b5' })
    expect(parseChord('Gsus4')?.quality).toBe('sus4')
    expect(parseChord('Bdim7')?.quality).toBe('dim7')
    expect(parseChord('Cm6')?.quality).toBe('min6')
    expect(parseChord('Dadd9')?.quality).toBe('add9')
    expect(parseChord('E9')?.quality).toBe('9')
    expect(parseChord('Faug')?.quality).toBe('aug')
  })

  it('returns null for no-chord and garbage', () => {
    expect(parseChord('N')).toBeNull()
    expect(parseChord('N.C.')).toBeNull()
    expect(parseChord('')).toBeNull()
    expect(parseChord('Hm')).toBeNull()
    expect(parseChord('Cxyz')).toBeNull()
    expect(parseChord('C/Q')).toBeNull()
  })

  it('accepts common alternative spellings', () => {
    expect(parseChord('Cmin7')?.quality).toBe('min7')
    expect(parseChord('CM7')?.quality).toBe('maj7')
    expect(parseChord('Cm7')?.quality).toBe('min7')
    expect(parseChord('CΔ7')?.quality).toBe('maj7')
    expect(parseChord('C-')?.quality).toBe('min')
    expect(parseChord('Cø')?.quality).toBe('hdim7')
    expect(parseChord('Csus')?.quality).toBe('sus4')
    expect(parseChord('C+')?.quality).toBe('aug')
    expect(parseChord('CMaj7')?.quality).toBe('maj7')
    expect(parseChord(' am ')).toMatchObject({ root: 'A', quality: 'min' })
  })

  it('drops a slash bass equal to the root', () => {
    expect(parseChord('C/C')?.bass).toBeNull()
  })
})

describe('formatChord / normalizeChord', () => {
  it('round-trips labels', () => {
    for (const l of ['C', 'C#m7', 'Ebmaj7', 'F/A', 'Am7b5', 'G#dim7', 'Bbsus2', 'D6', 'Em6', 'A9', 'Cadd9', 'Gaug']) {
      expect(formatChord(parseChord(l)!)).toBe(l)
    }
  })
  it('re-spells with a forced spelling', () => {
    expect(formatChord(parseChord('Ebm7')!, 'sharp')).toBe('D#m7')
    expect(formatChord(parseChord('A#/C#')!, 'flat')).toBe('Bb/Db')
    expect(normalizeChord('Bbmin7')).toBe('A#m7')
    expect(normalizeChord('N.C.')).toBe('N')
  })
})

describe('transposeChord', () => {
  it('transposes root and slash bass', () => {
    expect(transposeChord('Am', 2)).toBe('Bm')
    expect(transposeChord('G/B', 2)).toBe('A/C#')
    expect(transposeChord('G/B', 3, 'flat')).toBe('Bb/D')
    expect(transposeChord('B', 1)).toBe('C')
    expect(transposeChord('C', -1)).toBe('B')
    expect(transposeChord('C#m7', 12)).toBe('C#m7')
    expect(transposeChord('Ebmaj7', -3, 'sharp')).toBe('Cmaj7')
    expect(transposeChord('F#m7b5', 1, 'flat')).toBe('Gm7b5')
  })
  it('leaves N and unknown labels alone', () => {
    expect(transposeChord('N', 5)).toBe('N')
    expect(transposeChord('weird', 5)).toBe('weird')
  })
})

describe('simplifyChord', () => {
  it('reduces to triads', () => {
    expect(simplifyChord('Cmaj7')).toBe('C')
    expect(simplifyChord('G7')).toBe('G')
    expect(simplifyChord('D6')).toBe('D')
    expect(simplifyChord('E9')).toBe('E')
    expect(simplifyChord('Cadd9')).toBe('C')
    expect(simplifyChord('Am7')).toBe('Am')
    expect(simplifyChord('Em6')).toBe('Em')
    expect(simplifyChord('Bm7b5')).toBe('Bdim')
    expect(simplifyChord('Bdim7')).toBe('Bdim')
    expect(simplifyChord('Caug')).toBe('Caug')
    expect(simplifyChord('Gsus4')).toBe('G')
    expect(simplifyChord('Dsus2')).toBe('D')
  })
  it('drops the slash bass and keeps the root spelling', () => {
    expect(simplifyChord('G/B')).toBe('G')
    expect(simplifyChord('Ebmaj7/G')).toBe('Eb')
    expect(simplifyChord('N')).toBe('N')
  })
})

describe('chord tones & display parts', () => {
  it('computes pitch classes', () => {
    expect(chordPitchClasses(parseChord('Am')!)).toEqual([9, 0, 4])
    expect(chordPitchClasses(parseChord('G7')!)).toEqual([7, 11, 2, 5])
    expect(chordPitchClasses(parseChord('C/E')!)).toEqual([0, 4, 7])
    expect(chordPitchClasses(parseChord('Am/G')!)).toEqual([7, 9, 0, 4])
  })
  it('splits labels for typography', () => {
    expect(splitLabel('F#m7/E')).toEqual({ root: 'F#', suffix: 'm7', bass: 'E' })
    expect(splitLabel('N')).toEqual({ root: 'N', suffix: '', bass: null })
  })
})
