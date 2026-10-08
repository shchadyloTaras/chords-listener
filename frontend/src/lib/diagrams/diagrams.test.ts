import { describe, expect, it } from 'vitest'
import { parseChord } from '../music/chord'
import { loadChordDb, lookupLabel } from './chordsDb'
import { PIANO_KEYS, PIANO_LOW, pianoVoicing } from './piano'

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

describe('piano voicing: the left hand plays the bass, the right hand the chord around middle C', () => {
  // keys from C2 (key 0): C3 = 12, C4 = 24, C5 = 36
  const v = (label: string) => pianoVoicing(parseChord(label)!)
  const midi = (keys: number[]) => keys.map((k) => PIANO_LOW + k)

  it('puts the root alone in the bass register (E2–D#3), the triad in close position around E4', () => {
    expect(v('C')).toEqual({ notes: [12, 24, 28, 31], bass: 12, right: [24, 28, 31] }) // C3 | C4 E4 G4
    expect(v('Am')).toEqual({ notes: [9, 24, 28, 33], bass: 9, right: [24, 28, 33] }) // A2 | C4 E4 A4
  })

  it('takes the inversion nearest the resting hand, so I–IV–V–vi barely move (C E G, C F A, B D G, C E A)', () => {
    expect(midi(v('F').right)).toEqual([60, 65, 69])
    expect(midi(v('G').right)).toEqual([59, 62, 67])
    const order = ['C', 'F', 'G', 'C', 'Am', 'F', 'G', 'C']
    for (let i = 1; i < order.length; i++) {
      const a = v(order[i - 1]).right
      for (const k of v(order[i]).right) expect(Math.min(...a.map((x) => Math.abs(x - k)))).toBeLessThanOrEqual(2)
    }
  })

  it('gives a slash bass to the left hand, the plain chord to the right', () => {
    expect(v('C/E')).toEqual({ notes: [4, 24, 28, 31], bass: 4, right: [24, 28, 31] }) // E2 | C4 E4 G4
    expect(midi([v('G/B').bass])).toEqual([47]) // B2
    expect(midi(v('C/D').right)).toEqual([60, 64, 67])
  })

  it('leaves the bass out of the right hand of a 7th (3-5-7), then the fifth of a 9th (3-7-9)', () => {
    expect(midi(v('C7').right)).toEqual([58, 64, 67]) // Bb3 E4 G4
    expect(midi(v('Cmaj7').right)).toEqual([59, 64, 67]) // B3 E4 G4
    expect(midi(v('C9').right)).toEqual([62, 64, 70]) // D4 E4 Bb4
    expect(midi(v('Am7/G').right)).toEqual([60, 64, 69]) // C4 E4 A4: the bass G is the left hand's
  })

  it('keeps every chord in its hands: bass E2–D#3, the right hand within F3–C5 in close position, on the keyboard', () => {
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
    const suffixes = ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus2', 'sus4', 'dim7', 'm7b5', '6', 'm6', '9', 'add9']
    for (const root of roots)
      for (const suffix of suffixes)
        for (const slash of ['', '/E', '/G#']) {
          const p = parseChord(root + suffix + slash)!
          const { notes, bass, right } = pianoVoicing(p)
          const bassMidi = PIANO_LOW + bass
          expect(bassMidi).toBeGreaterThanOrEqual(40)
          expect(bassMidi).toBeLessThanOrEqual(51)
          expect(bassMidi % 12).toBe(p.bassPc ?? p.rootPc)
          expect(right.length).toBeGreaterThanOrEqual(3)
          expect(right.length).toBeLessThanOrEqual(4)
          expect(PIANO_LOW + right[0]).toBeGreaterThanOrEqual(53)
          expect(PIANO_LOW + right.at(-1)!).toBeLessThanOrEqual(72)
          expect(right.at(-1)! - right[0]).toBeLessThan(12)
          expect(notes).toEqual([bass, ...right].sort((a, b) => a - b))
          expect(notes.every((k) => k >= 0 && k < PIANO_KEYS)).toBe(true)
        }
  })
})
