// The Indian hand harmonium's keyboard: 37 keys from C3 to C6 (three octaves and the top C, 22
// white + 15 black keys, the black ones grouped 2-3-2-3-2-3), and which of them a chord lights —
// one right-hand shape (the left hand pumps the bellows), exactly the notes its staff shows and the
// chord sound plays.

import { QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { mod12 } from '../music/notes'
import { BLACK_PCS } from './piano'
import { spellNotes, type SpelledNote } from './staff'

export const HARMONIUM_KEYS = 37
/** MIDI note of key 0 (C3) */
export const HARMONIUM_LOW = 48
/** MIDI note of the last key (C6) */
export const HARMONIUM_HIGH = HARMONIUM_LOW + HARMONIUM_KEYS - 1
export const HARMONIUM_WHITES = 22

/** white-key index within the octave for each pitch class (black keys: the white key on their left) */
const WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

export interface HarmoniumVoicing {
  /** key indices 0..36 (0 = C3), ascending: one hand's shape, its lowest note the bass */
  notes: number[]
}

/** The shape's lowest note sits in the octave from middle C (keys 12–23). */
const HAND_LOW = 12
/** At most this many notes in the hand; past it the perfect fifth is left out. */
const HAND_NOTES = 4

export function harmoniumKeyMidi(key: number): number {
  return HARMONIUM_LOW + key
}

/** Key index of a MIDI note; null when the harmonium does not have it. */
export function harmoniumMidiKey(midi: number): number | null {
  return midi >= HARMONIUM_LOW && midi <= HARMONIUM_HIGH ? midi - HARMONIUM_LOW : null
}

export function isHarmoniumBlack(key: number): boolean {
  return BLACK_PCS.has(key % 12)
}

/** White-key slot 0..21 from the left; a black key gets the slot of the white key on its left. */
export function harmoniumWhiteSlot(key: number): number {
  return Math.floor(key / 12) * 7 + WHITE_INDEX[key % 12]
}

/** All keys, split into white and black, low → high. */
export function harmoniumKeys(): { whites: number[]; blacks: number[] } {
  const whites: number[] = []
  const blacks: number[] = []
  for (let k = 0; k < HARMONIUM_KEYS; k++) (isHarmoniumBlack(k) ? blacks : whites).push(k)
  return { whites, blacks }
}

/**
 * The chord as one hand plays it — on the hand harmonium the left hand pumps the bellows, so there
 * is no separate bass: the bass (slash bass, else root) is the shape's lowest note, in the octave
 * from middle C, and the other chord tones sit closest above it, all within an octave. A chord of
 * five tones (a 9th, a slash bass outside the chord) leaves out its perfect fifth.
 */
export function harmoniumVoicing(chord: ParsedChord): HarmoniumVoicing {
  const bassPc = chord.bassPc ?? chord.rootPc
  const above = new Set(QUALITY_INTERVALS[chord.quality].map((i) => mod12(chord.rootPc + i - bassPc)))
  above.delete(0)
  if (above.size + 1 > HAND_NOTES) above.delete(mod12(chord.rootPc + 7 - bassPc))
  const low = HAND_LOW + bassPc
  return { notes: [low, ...[...above].sort((a, b) => a - b).map((d) => low + d)] }
}

/** The shape's notes as its staff writes them (treble clef alone), spelled by chord degree. */
export function harmoniumStaff(chord: ParsedChord, voicing: HarmoniumVoicing = harmoniumVoicing(chord)): SpelledNote[] {
  return spellNotes(chord, voicing.notes.map((k) => k + HARMONIUM_LOW))
}
