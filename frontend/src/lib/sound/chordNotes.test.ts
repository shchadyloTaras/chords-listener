import { describe, expect, it } from 'vitest'
import { bassVoicings } from '../diagrams/bass'
import { harmoniumVoicing } from '../diagrams/harmonium'
import { loadChordDb, lookupLabel, type DbInstrument } from '../diagrams/chordsDb'
import { customScale, DEFAULT_HANDPAN_NOTES, formatHandpanNote, parseHandpanNote, presetScale } from '../handpan'
import { parseChord } from '../music/chord'
import { pcToName } from '../music/notes'
import {
  BASS_STEP,
  fallbackFretNotes,
  fretChordNotes,
  HANDPAN_STEP,
  handpanChordNotes,
  handpanFieldNote,
  handpanMidis,
  HARMONIUM_SPREAD,
  harmoniumChordNotes,
  harmoniumKeyNote,
  pianoChordNotes,
  pianoKeyNote,
  pickChordIndex,
  strumOffsets,
  voicingStrings,
} from './chordNotes'

const LABELS = ['C', 'Gm', 'F#m7', 'C/E', 'Bb', 'N'] as const

/** "C4"-style name of a MIDI note (sharps). */
const name = (midi: number) => `${pcToName(midi % 12)}${Math.floor(midi / 12) - 1}`
const midis = (notes: { midi: number }[]) => notes.map((n) => n.midi)

describe('piano: the staff voicing', () => {
  it('plays the left-hand bass and the right-hand notes the diagram shows', () => {
    const played = Object.fromEntries(LABELS.map((l) => [l, midis(pianoChordNotes(l))]))
    expect(played).toEqual({
      C: [48, 60, 64, 67], // C3 | C4 E4 G4
      Gm: [55, 67, 70, 74], // G3 | G4 Bb4 D5
      'F#m7': [54, 66, 69, 73, 76], // F#3 | F#4 A4 C#5 E5
      'C/E': [52, 72, 76, 79], // E3 | C5 E5 G5
      Bb: [58, 70, 74, 77], // Bb3 | Bb4 D5 F5
      N: [],
    })
  })

  it('sounds the bass a hair earlier and stronger, like a pianist', () => {
    const [bass, ...right] = pianoChordNotes('Am')
    expect(bass.offset).toBe(0)
    for (const n of right) {
      expect(n.offset).toBeGreaterThan(0.01)
      expect(n.offset).toBeLessThan(0.04)
      expect(n.velocity).toBeLessThan(bass.velocity)
    }
  })

  it('maps every note to the key it lights on the two-octave diagram', () => {
    // key 0 = C4; the left-hand bass lights its own pitch class in the lower octave (the bass marker)
    expect(pianoChordNotes('C').map((n) => n.target)).toEqual([0, 0, 4, 7])
    expect(pianoChordNotes('C/E').map((n) => n.target)).toEqual([4, 12, 16, 19])
    expect(pianoKeyNote(9)).toMatchObject({ midi: 69, target: 9 })
  })
})

describe('guitar / ukulele: the displayed chords-db voicing', () => {
  async function first(instrument: DbInstrument, label: string) {
    const db = await loadChordDb(instrument)
    const found = lookupLabel(db, instrument, label)
    return found && found.voicings.length ? fretChordNotes(found.voicings[0], instrument) : []
  }

  it('strums the guitar shape string by string (muted strings skipped)', async () => {
    const played: Record<string, number[]> = {}
    for (const l of LABELS) played[l] = midis(await first('guitar', l))
    expect(played).toEqual({
      C: [48, 52, 55, 60, 64], // x32010
      Gm: [43, 46, 50, 55, 62, 67], // 310033
      'F#m7': [42, 49, 52, 57, 61, 66], // 242222
      'C/E': [40, 48, 52, 55, 60, 64], // 032010
      Bb: [46, 53, 58, 62, 65], // x13331
      N: [],
    })
    expect((await first('guitar', 'C')).map((n) => n.target)).toEqual([1, 2, 3, 4, 5])
  })

  it('strums the ukulele from the re-entrant G string', async () => {
    const played: Record<string, number[]> = {}
    for (const l of LABELS) played[l] = midis(await first('ukulele', l))
    expect(played).toEqual({
      C: [67, 60, 64, 72], // 0003: G4 C4 E4 C5
      Gm: [67, 62, 67, 70], // 0231
      'F#m7': [69, 64, 66, 73], // 2424
      'C/E': [67, 60, 64, 72], // no C/E shape: the diagram shows ≈ C, so does the sound
      Bb: [70, 62, 65, 70], // 3211
      N: [],
    })
  })

  it('computes the notes from frets when a shape has no midi list', () => {
    const shape = { frets: [-1, 3, 2, 0, 1, 0], fingers: [], baseFret: 1, barres: [] }
    expect(voicingStrings(shape, 'guitar')).toEqual([
      { string: 1, midi: 48 },
      { string: 2, midi: 52 },
      { string: 3, midi: 55 },
      { string: 4, midi: 60 },
      { string: 5, midi: 64 },
    ])
    const barre = { frets: [1, 1, 3, 3, 3, 1], fingers: [], baseFret: 3, barres: [1] }
    expect(voicingStrings(barre, 'guitar').map((s) => s.midi)).toEqual([43, 48, 55, 60, 64, 67])
  })

  it('falls back to a plain root-position voicing', () => {
    expect(midis(fallbackFretNotes(parseChord('C')!, 'guitar')).map(name)).toEqual(['C3', 'E3', 'G3', 'C4', 'E4', 'G4'])
    expect(midis(fallbackFretNotes(parseChord('Am')!, 'guitar')).map(name)).toEqual(['A2', 'C3', 'E3', 'A3', 'C4', 'E4'])
    expect(midis(fallbackFretNotes(parseChord('C/E')!, 'guitar'))[0]).toBe(40) // E2 in the bass
    expect(midis(fallbackFretNotes(parseChord('C')!, 'ukulele')).map(name)).toEqual(['C4', 'E4', 'G4', 'C5'])
  })

  it('spaces the strings like a real downstroke', () => {
    for (const [instrument, count, lo, hi] of [
      ['guitar', 6, 0.015, 0.022],
      ['guitar', 4, 0.015, 0.022],
      ['ukulele', 4, 0.012, 0.016],
    ] as const) {
      const offsets = strumOffsets(count, instrument)
      expect(offsets).toHaveLength(count)
      expect(offsets[0]).toBe(0)
      for (let i = 1; i < count; i++) {
        const gap = offsets[i] - offsets[i - 1]
        expect(gap).toBeGreaterThanOrEqual(lo)
        expect(gap).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('gets slightly softer across the strum', async () => {
    const notes = await first('guitar', 'Gm')
    for (let i = 1; i < notes.length; i++) expect(notes[i].velocity).toBeLessThan(notes[i - 1].velocity)
    expect(notes[notes.length - 1].velocity).toBeGreaterThan(notes[0].velocity * 0.7)
  })
})

describe('bass: the generated voicing', () => {
  it('arpeggiates the shown shape low → high, 110 ms apart, the bass a bit stronger', () => {
    const [shape] = bassVoicings(parseChord('Am')!).voicings
    const notes = fretChordNotes(shape, 'bass')
    expect(midis(notes)).toEqual([33, 36, 40, 45]) // A1 C2 E2 A2
    expect(notes.map((n) => n.offset)).toEqual([0, 1, 2, 3].map((i) => i * BASS_STEP))
    expect(notes.map((n) => n.target)).toEqual([0, 1, 2, 3])
    expect(notes[0].velocity).toBeGreaterThan(notes[1].velocity)
    for (const n of notes) expect(Math.abs(n.pan ?? 0)).toBeLessThanOrEqual(0.08)
  })

  it('skips muted strings and lights the sounding ones', () => {
    const [shape] = bassVoicings(parseChord('C')!).voicings // x 3 2 0: C2 E2 G2
    const notes = fretChordNotes(shape, 'bass')
    expect(midis(notes)).toEqual([36, 40, 43])
    expect(notes.map((n) => n.target)).toEqual([1, 2, 3])
  })
})

describe('harmonium: the staff notes on its 37 keys, held together', () => {
  it('plays the piano staff notes, the right hand 10 ms after the bass', () => {
    for (const label of ['C', 'F#m7', 'C/E']) {
      const h = harmoniumChordNotes(label)
      const p = pianoChordNotes(label)
      expect(midis(h)).toEqual(midis(p))
      expect(h[0].offset).toBe(0)
      for (const n of h.slice(1)) expect(n.offset).toBeCloseTo(HARMONIUM_SPREAD, 6)
    }
    expect(harmoniumChordNotes('N')).toEqual([])
  })

  it('lights the harmonium keys the notes sound on (key 0 = C3)', () => {
    expect(harmoniumChordNotes('C').map((n) => n.target)).toEqual([0, 12, 16, 19])
    expect(harmoniumChordNotes('C/E').map((n) => n.target)).toEqual([4, 24, 28, 31])
    for (const label of ['Am', 'Bb', 'G7', 'Cmaj7', 'C/G', 'B9']) {
      expect(harmoniumChordNotes(label).map((n) => n.target)).toEqual(harmoniumVoicing(parseChord(label)!).notes)
    }
  })

  it('plays a clicked key from C3, leaving the piano diagram at C4', () => {
    expect(harmoniumKeyNote(0)).toMatchObject({ midi: 48, target: 0 })
    expect(harmoniumKeyNote(36)).toMatchObject({ midi: 84, target: 36 })
    expect(pianoKeyNote(0)).toMatchObject({ midi: 60, target: 0 })
  })
})

describe('handpan', () => {
  const mine = customScale(DEFAULT_HANDPAN_NOTES)
  const kurd = presetScale('d-kurd')!
  const names = (scale: Parameters<typeof handpanMidis>[0]) => handpanMidis(scale).map(name)

  it('infers plausible octaves for a scale written without them', () => {
    // A | D F A C G E C A → ding A2, fields A3–C5; of two same-named fields the one nearer the
    // player (bottom of the ring) is the lower one
    expect(names(mine)).toEqual(['A2', 'D4', 'F4', 'A4', 'C5', 'G4', 'E4', 'C4', 'A3'])
    // the D Kurd notes without octaves come out as the real D Kurd
    const bare = customScale(['D', 'A', 'A#', 'C', 'D', 'E', 'F', 'G', 'A'])
    expect(names(bare)).toEqual(['D3', 'A3', 'A#3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4'])
    // dings sit between A2 and G#3
    expect(handpanMidis(customScale(['C#', 'G#', 'B', 'C#', 'D#', 'E', 'F#', 'G#', 'B']))[0]).toBe(49)
    expect(handpanMidis(customScale(['G#', 'C', 'D', 'D#', 'F', 'G', 'G#', 'A#']))[0]).toBe(56)
  })

  it('keeps octaves that are written, inferring only the rest', () => {
    expect(handpanMidis(kurd).map(name)).toEqual(kurd.notes.map((n) => formatHandpanNote(n).replace('Bb', 'A#')))
    const mixed = customScale(['D3', 'A3', 'Bb3', 'C', 'D', 'E', 'F', 'G', 'A4'])
    expect(names(mixed)).toEqual(['D3', 'A3', 'A#3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4'])
    // a written field below the guessed ding pushes the ding down
    const low = customScale(['A', 'F2', 'C3', 'D', 'E', 'F', 'G', 'A', 'C'])
    expect(handpanMidis(low)[0]).toBeLessThan(handpanMidis(low)[1])
    expect(parseHandpanNote('F2')).not.toBeNull()
  })

  it('plays only the chord tones the handpan has, low → high', () => {
    const played = Object.fromEntries(LABELS.map((l) => [l, midis(handpanChordNotes(l, mine)).map(name)]))
    expect(played).toEqual({
      C: ['C4', 'E4', 'G4', 'C5'],
      Gm: ['D4', 'G4'], // no Bb on this handpan
      'F#m7': ['A2', 'E4'], // only A and E
      'C/E': ['E4', 'G4', 'C5'],
      Bb: ['D4', 'F4'],
      N: [],
    })
    expect(midis(handpanChordNotes('Am', mine)).map(name)).toEqual(['A2', 'A3', 'C4', 'E4'])
    expect(midis(handpanChordNotes('Dm', kurd)).map(name)).toEqual(['D3', 'A3', 'D4', 'F4'])
  })

  it('arpeggiates 70 ms apart and lights the struck fields', () => {
    const am = handpanChordNotes('Am', mine)
    am.forEach((n, i) => expect(n.offset).toBeCloseTo(i * HANDPAN_STEP, 6))
    expect(HANDPAN_STEP).toBeGreaterThanOrEqual(0.06)
    expect(HANDPAN_STEP).toBeLessThanOrEqual(0.08)
    expect(am.map((n) => n.target)).toEqual([0, 8, 7, 6]) // ding, A3, C4, E4 (note indices)
    expect(am[0].velocity).toBeGreaterThan(am[1].velocity)
  })

  it('plays nothing when none of the chord is on the instrument', () => {
    expect(handpanChordNotes('B', mine)).toEqual([]) // B D# F#: none on A | D F A C G E C A
    expect(handpanChordNotes('Ebm', mine)).toEqual([])
    expect(handpanChordNotes('B', kurd)).toEqual([])
  })

  it('plays a single struck field', () => {
    expect(handpanFieldNote(mine, 0)).toMatchObject({ midi: 45, target: 0, pan: 0 })
    expect(handpanFieldNote(mine, 8)).toMatchObject({ midi: 57, target: 8 })
    expect(handpanFieldNote(mine, 99)).toBeNull()
  })
})

describe('which chord P plays', () => {
  const chords = [
    { start: 0, end: 2, isNone: true },
    { start: 2, end: 4, isNone: false },
    { start: 4, end: 6, isNone: true },
    { start: 6, end: 8, isNone: false },
  ]
  it('takes the current chord, else the selection, else the next, else the last', () => {
    expect(pickChordIndex(chords, 3, null)).toBe(1)
    expect(pickChordIndex(chords, 3, { start: 6, end: 8 })).toBe(1) // current wins
    expect(pickChordIndex(chords, 0.5, null)).toBe(1) // before the first chord → next
    expect(pickChordIndex(chords, 0.5, { start: 6, end: 8 })).toBe(3) // nothing current → selection
    expect(pickChordIndex(chords, 4.5, null)).toBe(3) // in "N" → next
    expect(pickChordIndex(chords, 9, null)).toBe(3) // after the end → last
    expect(pickChordIndex([], 1, null)).toBe(-1)
  })
})
