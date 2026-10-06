import { describe, expect, it } from 'vitest'
import { parseChord } from '../music/chord'
import {
  HARMONIUM_HIGH,
  HARMONIUM_KEYS,
  HARMONIUM_LOW,
  HARMONIUM_WHITES,
  harmoniumKeyMidi,
  harmoniumKeys,
  harmoniumMidiKey,
  harmoniumVoicing,
  harmoniumWhiteSlot,
  isHarmoniumBlack,
} from './harmonium'
import { pianoVoicing } from './piano'
import { staffChord } from './staff'

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

describe('harmonium voicing', () => {
  it('plays the bass in the lowest octave and the chord from middle C', () => {
    expect(voicing('C')).toEqual({ notes: [0, 12, 16, 19], bass: 0 })
    expect(voicing('Am')).toEqual({ notes: [9, 21, 24, 28], bass: 9 })
    expect(voicing('F#m')).toEqual({ notes: [6, 18, 21, 25], bass: 6 })
    expect(voicing('Bb')).toEqual({ notes: [10, 22, 26, 29], bass: 10 })
    expect(voicing('G7')).toEqual({ notes: [7, 19, 23, 26, 29], bass: 7 })
    expect(voicing('Cmaj7')).toEqual({ notes: [0, 12, 16, 19, 23], bass: 0 })
  })

  it('takes a slash bass out of the right hand, like the staff', () => {
    expect(voicing('C/G')).toEqual({ notes: [7, 24, 28, 31], bass: 7 })
    expect(voicing('C/E')).toEqual({ notes: [4, 24, 28, 31], bass: 4 })
  })

  it('lights exactly the notes the grand staff shows, all on the keyboard', () => {
    for (const label of ['C', 'Am', 'F#m', 'Bb', 'C/G', 'G7', 'Cmaj7', 'B9', 'Cdim7', 'D/F#', 'Ebm6', 'Bbadd9/C']) {
      const parsed = parseChord(label)!
      const staff = staffChord(parsed, pianoVoicing(parsed))
      const v = harmoniumVoicing(parsed)
      expect(v.notes).toEqual([staff.bass, ...staff.treble].map((n) => n.midi - 48))
      expect(v.bass).toBe(staff.bass.midi - 48)
      expect(v.notes.every((k) => k >= 0 && k < HARMONIUM_KEYS)).toBe(true)
    }
  })
})
