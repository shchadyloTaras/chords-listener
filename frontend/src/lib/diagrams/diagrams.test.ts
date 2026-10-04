import { describe, expect, it } from 'vitest'
import { parseChord } from '../music/chord'
import { loadChordDb, lookupLabel } from './chordsDb'
import { pianoVoicing } from './piano'

describe('chords-db lookup', () => {
  it('finds exact guitar shapes incl. enharmonic roots and slash chords', async () => {
    const db = await loadChordDb('guitar')
    expect(lookupLabel(db, 'guitar', 'C')?.voicings[0].frets).toEqual([-1, 3, 2, 0, 1, 0])
    const cs = lookupLabel(db, 'guitar', 'C#m7')
    expect(cs?.exact).toBe(true)
    expect(cs?.voicings.length).toBeGreaterThan(0)
    expect(lookupLabel(db, 'guitar', 'A#m')?.exact).toBe(true) // Bb key
    expect(lookupLabel(db, 'guitar', 'Am7b5')?.exact).toBe(true)
    const gb = lookupLabel(db, 'guitar', 'G/B')
    expect(gb).toMatchObject({ exact: true, shown: 'G/B' })
    expect(gb?.voicings[0].frets).toEqual([-1, 2, 0, 0, 3, 3])
    expect(lookupLabel(db, 'guitar', 'D/A#')?.exact).toBe(true) // stored as "/Bb"
    expect(lookupLabel(db, 'guitar', 'N')).toBeNull()
  })

  it('falls back to the base chord or triad when a shape is missing', async () => {
    const db = await loadChordDb('guitar')
    const slash = lookupLabel(db, 'guitar', 'F#/A#')
    expect(slash).toMatchObject({ exact: false, shown: 'F#' })
    const uke = await loadChordDb('ukulele')
    expect(lookupLabel(uke, 'ukulele', 'C')?.voicings[0].frets).toEqual([0, 0, 0, 3])
    expect(lookupLabel(uke, 'ukulele', 'F#m')?.exact).toBe(true) // Gb key
    expect(lookupLabel(uke, 'ukulele', 'G/B')).toMatchObject({ exact: false, shown: 'G' })
  })
})

describe('piano voicing', () => {
  it('stacks chord tones from the root', () => {
    expect(pianoVoicing(parseChord('C')!)).toEqual({ notes: [0, 4, 7], bass: 0 })
    expect(pianoVoicing(parseChord('Am')!)).toEqual({ notes: [9, 12, 16], bass: 9 })
    expect(pianoVoicing(parseChord('B9')!).notes.every((n) => n < 24)).toBe(true)
  })
  it('puts a slash bass lowest', () => {
    const v = pianoVoicing(parseChord('C/E')!)
    expect(v.bass).toBe(4)
    expect(v.notes).toEqual([4, 12, 16, 19])
  })
})
