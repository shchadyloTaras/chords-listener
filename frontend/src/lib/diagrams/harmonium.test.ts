import { describe, expect, it } from 'vitest'
import { chordPitchClasses, parseChord } from '../music/chord'
import {
  HARMONIUM_HIGH,
  HARMONIUM_KEYS,
  HARMONIUM_LOW,
  HARMONIUM_WHITES,
  harmoniumKeyMidi,
  harmoniumKeys,
  harmoniumMidiKey,
  harmoniumStaff,
  harmoniumVoicing,
  harmoniumWhiteSlot,
  isHarmoniumBlack,
} from './harmonium'

const voicing = (label: string) => harmoniumVoicing(parseChord(label)!)

describe('harmonium keyboard', () => {
  it('has the 37 keys of the instrument, C3 to C6', () => {
    expect(HARMONIUM_KEYS).toBe(37)
    expect(HARMONIUM_LOW).toBe(48)
    expect(HARMONIUM_HIGH).toBe(84)
    expect(harmoniumKeyMidi(0)).toBe(48)
    expect(harmoniumKeyMidi(36)).toBe(84)
    expect(harmoniumMidiKey(60)).toBe(12)
    expect(harmoniumMidiKey(47)).toBeNull()
    expect(harmoniumMidiKey(85)).toBeNull()
  })

  it('has 22 white and 15 black keys, a C at both ends', () => {
    const { whites, blacks } = harmoniumKeys()
    expect(whites).toHaveLength(22)
    expect(HARMONIUM_WHITES).toBe(22)
    expect(blacks).toHaveLength(15)
    expect(whites[0]).toBe(0)
    expect(whites[whites.length - 1]).toBe(36)
    expect(harmoniumKeyMidi(36) % 12).toBe(0)
    expect(isHarmoniumBlack(0) || isHarmoniumBlack(36)).toBe(false)
  })

  it('groups the black keys 2-3-2-3-2-3', () => {
    const { blacks } = harmoniumKeys()
    const groups: number[] = []
    blacks.forEach((k, i) => {
      // inside a group the black keys are a whole tone apart; across E–F / B–C a minor third
      if (i > 0 && k - blacks[i - 1] === 2) groups[groups.length - 1]++
      else groups.push(1)
    })
    expect(groups).toEqual([2, 3, 2, 3, 2, 3])
  })

  it('numbers the white keys from the left, a black key sitting after its white neighbour', () => {
    const { whites } = harmoniumKeys()
    whites.forEach((k, i) => expect(harmoniumWhiteSlot(k)).toBe(i))
    expect(harmoniumWhiteSlot(1)).toBe(0) // C#3 between C3 and D3
    expect(harmoniumWhiteSlot(13)).toBe(7) // C#4
    expect(harmoniumWhiteSlot(34)).toBe(19) // A#5, after A5
  })
})

describe('harmonium voicing: one hand (the left pumps the bellows)', () => {
  it('plays the chord in close position from its root, in the octave from middle C', () => {
    expect(voicing('C')).toEqual({ notes: [12, 16, 19] })
    expect(voicing('Am')).toEqual({ notes: [21, 24, 28] })
    expect(voicing('F#m')).toEqual({ notes: [18, 21, 25] })
    expect(voicing('Bb')).toEqual({ notes: [22, 26, 29] })
    expect(voicing('G7')).toEqual({ notes: [19, 23, 26, 29] })
    expect(voicing('Cmaj7')).toEqual({ notes: [12, 16, 19, 23] })
  })

  it('puts a slash bass at the bottom of the hand: an inversion, no separate bass', () => {
    expect(voicing('C/E')).toEqual({ notes: [16, 19, 24] }) // E G C
    expect(voicing('C/G')).toEqual({ notes: [19, 24, 28] }) // G C E
    expect(voicing('C/D')).toEqual({ notes: [14, 16, 19, 24] }) // D E G C
    expect(voicing('Bbadd9/C')).toEqual({ notes: [12, 14, 17, 22] }) // C D F Bb
  })

  it('leaves out the perfect fifth of a five-tone chord', () => {
    expect(voicing('C9')).toEqual({ notes: [12, 14, 16, 22] }) // C D E Bb
    expect(voicing('B9')).toEqual({ notes: [23, 25, 27, 33] }) // B C# D# A
  })

  it('fits every chord in one hand on the keyboard: bass lowest, within an octave, every other tone kept', () => {
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
    const suffixes = ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus2', 'sus4', 'dim7', 'm7b5', '6', 'm6', '9', 'add9']
    for (const root of roots)
      for (const suffix of [...suffixes, ...suffixes.map((s) => `${s}/E`)]) {
        const parsed = parseChord(root + suffix)!
        const { notes } = harmoniumVoicing(parsed)
        const bassPc = parsed.bassPc ?? parsed.rootPc
        expect(notes[0]).toBe(12 + bassPc)
        expect(notes.at(-1)! - notes[0]).toBeLessThan(12)
        expect(notes.length).toBeLessThanOrEqual(5)
        expect(notes.every((k, i) => k >= 0 && k < HARMONIUM_KEYS && (i === 0 || k > notes[i - 1]))).toBe(true)
        const fifth = (parsed.rootPc + 7) % 12
        const missing = chordPitchClasses(parsed).filter((pc) => !notes.some((k) => k % 12 === pc))
        expect(missing.every((pc) => pc === fifth && pc !== bassPc)).toBe(true)
      }
  })

  it('writes the shape on the treble staff, spelled by chord degree', () => {
    const names = (label: string) => harmoniumStaff(parseChord(label)!).map((n) => n.name + n.octave)
    expect(names('C')).toEqual(['C4', 'E4', 'G4'])
    expect(names('Gm')).toEqual(['G4', 'Bb4', 'D5'])
    expect(names('Cdim7')).toEqual(['C4', 'Eb4', 'Gb4', 'Bbb4'])
    expect(names('D/F#')).toEqual(['F#4', 'A4', 'D5'])
    for (const label of ['C', 'Am', 'G7', 'C/E', 'B9', 'Ebm6']) {
      const parsed = parseChord(label)!
      expect(harmoniumStaff(parsed).map((n) => n.midi)).toEqual(harmoniumVoicing(parsed).notes.map((k) => k + 48))
    }
  })
})
