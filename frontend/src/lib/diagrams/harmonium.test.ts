import { describe, expect, it } from 'vitest'
import { chordPitchClasses, parseChord } from '../music/chord'
import {
  HARMONIUM_HIGH,
  HARMONIUM_KEYS,
  HARMONIUM_LOW,
  HARMONIUM_SHAPE_HIGH,
  HARMONIUM_SHAPE_LOW,
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

describe('harmonium voicing: one right hand (the left pumps the bellows), kept in one spot by inversions', () => {
  const names = (label: string) => voicing(label).notes.map((k) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][k % 12] + (3 + Math.floor(k / 12)))

  it('takes every chord in close position, the inversion nearest the resting hand (thumb on middle C)', () => {
    expect(names('C')).toEqual(['C4', 'E4', 'G4'])
    expect(names('F')).toEqual(['C4', 'F4', 'A4']) // second inversion
    expect(names('G')).toEqual(['B3', 'D4', 'G4']) // first inversion
    expect(names('Am')).toEqual(['C4', 'E4', 'A4'])
    expect(names('Dm')).toEqual(['D4', 'F4', 'A4'])
    expect(names('Em')).toEqual(['B3', 'E4', 'G4'])
    expect(names('G7')).toEqual(['B3', 'D4', 'F4', 'G4'])
    expect(names('Cmaj7')).toEqual(['C4', 'E4', 'G4', 'B4']) // a tie with B C E G: root position wins
  })

  it('moves the hand little between the common chords: I-IV-V-vi in C, every voice by at most a whole tone', () => {
    const order = ['C', 'F', 'G', 'C', 'Am', 'F', 'G7', 'C']
    for (let i = 1; i < order.length; i++) {
      const a = voicing(order[i - 1]).notes
      const b = voicing(order[i]).notes
      for (const k of b) expect(Math.min(...a.map((x) => Math.abs(x - k)))).toBeLessThanOrEqual(2)
    }
  })

  it('keeps a slash bass at the bottom of the hand', () => {
    expect(names('C/E')).toEqual(['E4', 'G4', 'C5'])
    expect(names('C/G')).toEqual(['G3', 'C4', 'E4'])
    expect(names('D/F#')).toEqual(['F#4', 'A4', 'D5'])
    expect(names('C/D')).toEqual(['D4', 'E4', 'G4', 'C5'])
  })

  it('leaves out the perfect fifth of a five-tone chord', () => {
    expect(names('C9')).toEqual(['C4', 'D4', 'E4', 'A#4']) // C D E Bb
    expect(names('B9')).toEqual(['B3', 'C#4', 'D#4', 'A4'])
  })

  it('fits every chord in one hand between G3 and F#5: within an octave, every tone but a dropped fifth kept', () => {
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
    const suffixes = ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus2', 'sus4', 'dim7', 'm7b5', '6', 'm6', '9', 'add9']
    for (const root of roots)
      for (const suffix of suffixes)
        for (const slash of ['', ...roots.map((r) => `/${r}`)]) {
          const parsed = parseChord(root + suffix + slash)!
          const { notes } = harmoniumVoicing(parsed)
          if (parsed.bassPc != null) expect(notes[0] % 12).toBe(parsed.bassPc)
          expect(notes[0]).toBeGreaterThanOrEqual(HARMONIUM_SHAPE_LOW)
          expect(notes.at(-1)!).toBeLessThanOrEqual(HARMONIUM_SHAPE_HIGH)
          expect(notes.at(-1)! - notes[0]).toBeLessThan(12)
          expect(notes.length).toBeLessThanOrEqual(5)
          expect(notes.every((k, i) => i === 0 || k > notes[i - 1])).toBe(true)
          const fifth = (parsed.rootPc + 7) % 12
          const missing = chordPitchClasses(parsed).filter((pc) => !notes.some((k) => k % 12 === pc))
          expect(missing.every((pc) => pc === fifth && pc !== parsed.bassPc)).toBe(true)
        }
  })

  it('writes the shape on the treble staff, spelled by chord degree', () => {
    const staff = (label: string) => harmoniumStaff(parseChord(label)!).map((n) => n.name + n.octave)
    expect(staff('C')).toEqual(['C4', 'E4', 'G4'])
    expect(staff('Gm')).toEqual(['Bb3', 'D4', 'G4'])
    expect(staff('Cdim7')).toEqual(['C4', 'Eb4', 'Gb4', 'Bbb4'])
    expect(staff('D/F#')).toEqual(['F#4', 'A4', 'D5'])
    for (const label of ['C', 'Am', 'G7', 'C/E', 'B9', 'Ebm6']) {
      const parsed = parseChord(label)!
      expect(harmoniumStaff(parsed).map((n) => n.midi)).toEqual(harmoniumVoicing(parsed).notes.map((k) => k + 48))
    }
  })
})
