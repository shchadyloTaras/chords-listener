import { describe, expect, it } from 'vitest'
import type { ChordQuality } from '../../types'
import { parseChord, QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { mod12, SHARP_NAMES } from '../music/notes'
import { BASS_TUNING, bassVoicings } from './bass'
import type { Voicing } from './chordsDb'

const SUFFIX: Record<ChordQuality, string> = {
  maj: '', min: 'm', '7': '7', maj7: 'maj7', min7: 'm7', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
  dim7: 'dim7', hdim7: 'm7b5', '6': '6', min6: 'm6', '9': '9', add9: 'add9',
}
const chord = (label: string): ParsedChord => parseChord(label)!
/** Absolute fret per string (−1 muted). */
const absolute = (v: Voicing) => v.frets.map((f) => (f <= 0 ? f : f + v.baseFret - 1))
const sounding = (v: Voicing) => absolute(v).flatMap((f, s) => (f >= 0 ? [{ s, f, midi: BASS_TUNING[s] + f }] : []))
const tones = (c: ParsedChord) => new Set([c.bassPc ?? c.rootPc, ...QUALITY_INTERVALS[c.quality].map((i) => mod12(c.rootPc + i))])

describe('bass voicings', () => {
  it('play every chord tone in one hand position, the bass lowest, rising string by string', () => {
    for (let pc = 0; pc < 12; pc++) {
      for (const q of Object.keys(SUFFIX) as ChordQuality[]) {
        const c = chord(SHARP_NAMES[pc] + SUFFIX[q])
        const found = bassVoicings(c)
        expect(found.strings).toBe(4)
        expect(found.exact, `${SHARP_NAMES[pc]}${SUFFIX[q]}`).toBe(true)
        expect(found.voicings.length).toBeGreaterThan(0)
        expect(found.voicings.length).toBeLessThanOrEqual(6)
        for (const v of found.voicings) {
          const notes = sounding(v)
          const held = new Set(notes.map((n) => mod12(n.midi)))
          const need = tones(c)
          // the perfect fifth may be left out; every other tone must be there
          const fifth = mod12(c.rootPc + 7)
          for (const t of need) if (t !== fifth || !['maj', 'min', '7', 'maj7', 'min7', 'sus2', 'sus4', '6', 'min6', '9', 'add9'].includes(q)) expect(held.has(t), `${SHARP_NAMES[pc]}${SUFFIX[q]} lacks ${t}`).toBe(true)
          for (const t of held) expect(need.has(t)).toBe(true)
          expect(mod12(notes[0].midi)).toBe(c.rootPc)
          expect(notes[0].s).toBeLessThan(2)
          for (let i = 1; i < notes.length; i++) expect(notes[i].midi).toBeGreaterThan(notes[i - 1].midi)
          const fretted = notes.map((n) => n.f).filter((f) => f > 0)
          if (fretted.length) expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(3)
          expect(v.midi).toEqual(notes.map((n) => n.midi))
        }
      }
    }
  })

  it('keeps the fifth unless the strings run out', () => {
    // A minor: A1 C2 E2 A2 at the 5th fret (E string) holds the fifth
    expect(sounding(bassVoicings(chord('Am')).voicings[0]).map((n) => n.midi)).toEqual([33, 36, 40, 45])
    // Fadd9 only fits without the fifth
    const fadd9 = bassVoicings(chord('Fadd9'))
    expect(fadd9.exact).toBe(true)
    for (const v of fadd9.voicings) expect(new Set(sounding(v).map((n) => mod12(n.midi)))).toEqual(new Set([5, 9, 7]))
  })

  it('puts the slash bass lowest', () => {
    for (const [label, bass] of [['C/G', 7], ['D/F#', 6], ['C/D', 2]] as const) {
      for (const v of bassVoicings(chord(label)).voicings) expect(mod12(sounding(v)[0].midi), label).toBe(bass)
    }
    expect(sounding(bassVoicings(chord('D/F#')).voicings[0]).map((n) => n.midi)).toEqual([30, 33, 38, 45])
  })

  it('orders shapes from the nut up and labels positions like chords-db', () => {
    const am = bassVoicings(chord('Am')).voicings
    const positions = am.map((v) => Math.min(...absolute(v).filter((f) => f > 0)))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    // G: G1 B1 D2 G2 in the open position (no fret label)
    const [g] = bassVoicings(chord('G')).voicings
    expect(g).toMatchObject({ frets: [3, 2, 0, 0], baseFret: 1, fingers: [2, 1, 0, 0], barres: [] })
    // Bb: up the neck, frets relative to the 3rd fret
    const [bb] = bassVoicings(chord('Bb')).voicings
    expect(bb).toMatchObject({ frets: [4, 3, 1, 1], baseFret: 3, fingers: [4, 3, 1, 1] })
  })

  it('falls back to the closest shapes when nothing holds every tone', () => {
    const found = bassVoicings(chord('Cmaj7/D'))
    expect(found.exact).toBe(false)
    expect(found.shown).toBe('Cmaj7/D')
    expect(found.voicings.length).toBeGreaterThan(0)
    for (const v of found.voicings) expect(mod12(sounding(v)[0].midi)).toBe(2)
  })
})
