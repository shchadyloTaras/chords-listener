// Grand-staff notation for a piano chord: right hand = the voicing's chord around middle C (treble
// clef), left hand = its bass (root or slash bass, E2–D#3) in the bass clef, each at the pitch it sounds.

import type { ChordQuality } from '../../types'
import { QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { PIANO_LOW, type PianoVoicing } from './piano'

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]

/** Diatonic letter steps above the root for each interval (mod 12) of a chord quality. */
function degreeOf(semis: number, quality: ChordQuality): number {
  const s = semis % 12
  if (quality === 'dim7' && s === 9) return 6 // diminished seventh (Bbb in Cdim7), not a sixth
  return [0, 1, 1, 2, 2, 3, 4, 4, 4, 5, 6, 6][s]
}

export interface SpelledNote {
  /** 0..6 = C..B */
  letter: number
  /** -2..2 (flats negative) */
  accidental: number
  octave: number
  midi: number
  /** steps from C0: octave * 7 + letter — the vertical staff position */
  step: number
  name: string
}

/** What a staff shows: the treble clef's notes and, on a grand staff, the left hand's bass. */
export interface StaffNotes {
  /** right hand, ascending */
  treble: SpelledNote[]
  /** left hand; none = the treble staff alone */
  bass?: SpelledNote
}

export interface StaffChord extends StaffNotes {
  /** left hand */
  bass: SpelledNote
}

function parseName(name: string): { letter: number; accidental: number } {
  const letter = LETTERS.indexOf(name[0].toUpperCase() as (typeof LETTERS)[number])
  let accidental = 0
  for (const ch of name.slice(1)) accidental += ch === '#' ? 1 : ch === 'b' ? -1 : 0
  return { letter, accidental }
}

function spell(midi: number, letter: number, accidental: number): SpelledNote {
  // Octave of the written letter (B#3 sounds as C4, Cb4 as B3).
  const octave = Math.round((midi - accidental - LETTER_PC[letter]) / 12) - 1
  const acc = accidental > 0 ? '#'.repeat(accidental) : 'b'.repeat(-accidental)
  return { letter, accidental, octave, midi, step: octave * 7 + letter, name: LETTERS[letter] + acc }
}

/** Letter + accidental for pitch class `pc` when it sits `degree` letters above `root`. */
function spellAbove(root: { letter: number; accidental: number }, pc: number, degree: number) {
  const letter = (root.letter + degree) % 7
  let accidental = (((pc - LETTER_PC[letter]) % 12) + 12) % 12
  if (accidental > 6) accidental -= 12
  return Math.abs(accidental) <= 2 ? { letter, accidental } : null
}

/** Fallback spelling for a pitch class that has no chord-degree spelling. */
function plainSpelling(pc: number, preferFlat: boolean) {
  const natural = LETTER_PC.indexOf(pc)
  if (natural >= 0) return { letter: natural, accidental: 0 }
  return preferFlat ? { letter: LETTER_PC.indexOf(pc + 1), accidental: -1 } : { letter: LETTER_PC.indexOf(pc - 1), accidental: 1 }
}

/** Letter + accidental of each pitch class by its degree in the chord, counted in thirds from the written root. */
function degreeSpelling(chord: ParsedChord): (pc: number) => { letter: number; accidental: number } {
  const root = parseName(chord.root)
  const preferFlat = root.accidental < 0
  const byPc = new Map<number, { letter: number; accidental: number }>()
  for (const semis of QUALITY_INTERVALS[chord.quality]) {
    const pc = (chord.rootPc + semis) % 12
    if (!byPc.has(pc)) {
      const s = spellAbove(root, pc, degreeOf(semis, chord.quality))
      if (s) byPc.set(pc, s)
    }
  }
  return (pc) => byPc.get(pc) ?? plainSpelling(pc, preferFlat)
}

/**
 * The piano voicing on the grand staff: the right hand in the treble clef, the left hand's bass in the
 * bass clef, each at the pitch it sounds. Spelled by thirds from the written root (Gm → G Bb D, F#m →
 * F# A C#, Cdim7 → C Eb Gb Bbb), so the staff never shows A# in a G minor chord; a slash bass as
 * written after the slash.
 */
export function staffChord(chord: ParsedChord, voicing: PianoVoicing): StaffChord {
  const [bass] = spellNotes(chord, [PIANO_LOW + voicing.bass])
  return { treble: spellNotes(chord, voicing.right.map((k) => PIANO_LOW + k)), bass }
}

/**
 * The given notes (MIDI, ascending) spelled like staffChord spells them, a slash bass as written after
 * the slash: one hand's notes on the treble staff alone.
 */
export function spellNotes(chord: ParsedChord, midis: number[]): SpelledNote[] {
  const nameFor = degreeSpelling(chord)
  const slash = chord.bassPc != null && chord.bass ? parseName(chord.bass) : null
  return midis.map((midi) => {
    const s = slash && midi % 12 === chord.bassPc ? slash : nameFor(midi % 12)
    return spell(midi, s.letter, s.accidental)
  })
}
