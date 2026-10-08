import { describe, expect, it } from 'vitest'
import { parseChord } from '../music/chord'
import { pianoVoicing } from './piano'
import { staffChord } from './staff'

function staff(label: string) {
  const p = parseChord(label)
  if (!p) throw new Error(`bad label ${label}`)
  const s = staffChord(p, pianoVoicing(p))
  return {
    treble: s.treble.map((n) => `${n.name}${n.octave}`),
    bass: `${s.bass.name}${s.bass.octave}`,
  }
}

describe('staffChord', () => {
  it('writes the right hand around middle C in the treble clef, the left hand\'s bass at its pitch in the bass clef', () => {
    expect(staff('C')).toEqual({ treble: ['C4', 'E4', 'G4'], bass: 'C3' })
    expect(staff('G')).toEqual({ treble: ['B3', 'D4', 'G4'], bass: 'G2' })
  })

  it('spells chords by thirds from the written root', () => {
    expect(staff('Gm').treble).toEqual(['Bb3', 'D4', 'G4'])
    expect(staff('F#m').treble).toEqual(['C#4', 'F#4', 'A4'])
    expect(staff('Bb7').treble).toEqual(['D4', 'F4', 'Ab4']) // the root is the left hand's
    expect(staff('Ebmaj7').treble).toEqual(['Bb3', 'D4', 'G4'])
    expect(staff('Caug').treble).toEqual(['C4', 'E4', 'G#4'])
    expect(staff('Bdim').treble).toEqual(['B3', 'D4', 'F4'])
  })

  it('uses a double flat for the diminished seventh', () => {
    expect(staff('Cdim7')).toEqual({ treble: ['Eb4', 'Gb4', 'Bbb4'], bass: 'C3' })
  })

  it('gives a slash bass to the left hand, as written', () => {
    expect(staff('C/E')).toEqual({ treble: ['C4', 'E4', 'G4'], bass: 'E2' })
    expect(staff('G/B')).toEqual({ treble: ['B3', 'D4', 'G4'], bass: 'B2' })
    expect(staff('D/F#').bass).toBe('F#2')
  })

  it('keeps staff steps consistent with the written octave', () => {
    const p = parseChord('Cdim7')!
    const bbb = staffChord(p, pianoVoicing(p)).treble[2]
    expect(bbb.midi).toBe(69)
    expect(bbb.step).toBe(4 * 7 + 6)
  })
})
