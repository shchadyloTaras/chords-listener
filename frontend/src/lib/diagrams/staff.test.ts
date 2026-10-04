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
  it('puts a root-position triad from middle C with the root in the bass clef', () => {
    expect(staff('C')).toEqual({ treble: ['C4', 'E4', 'G4'], bass: 'C3' })
  })

  it('spells chords by thirds from the written root', () => {
    expect(staff('Gm').treble).toEqual(['G4', 'Bb4', 'D5'])
    expect(staff('F#m').treble).toEqual(['F#4', 'A4', 'C#5'])
    expect(staff('Bb7').treble).toEqual(['Bb4', 'D5', 'F5', 'Ab5'])
    expect(staff('Ebmaj7').treble).toEqual(['Eb4', 'G4', 'Bb4', 'D5'])
    expect(staff('Caug').treble).toEqual(['C4', 'E4', 'G#4'])
    expect(staff('Bdim').treble).toEqual(['B4', 'D5', 'F5'])
  })

  it('uses a double flat for the diminished seventh', () => {
    expect(staff('Cdim7').treble).toEqual(['C4', 'Eb4', 'Gb4', 'Bbb4'])
  })

  it('moves a slash bass to the left hand', () => {
    expect(staff('C/E')).toEqual({ treble: ['C5', 'E5', 'G5'], bass: 'E3' })
    expect(staff('G/B')).toEqual({ treble: ['D5', 'G5', 'B5'], bass: 'B3' })
  })

  it('keeps staff steps consistent with the written octave', () => {
    const p = parseChord('Cdim7')!
    const bbb = staffChord(p, pianoVoicing(p)).treble[3]
    expect(bbb.midi).toBe(69)
    expect(bbb.step).toBe(4 * 7 + 6)
  })
})
