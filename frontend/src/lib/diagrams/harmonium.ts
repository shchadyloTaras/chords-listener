// The Indian hand harmonium's keyboard: 37 keys from C3 to C6 (three octaves and the top C, 22
// white + 15 black keys, the black ones grouped 2-3-2-3-2-3), and which of them a chord lights —
// one right-hand shape (the left hand pumps the bellows) kept in one spot by inversions, exactly
// the notes its staff shows and the chord sound plays.

import { QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { mod12 } from '../music/notes'
import { closeShape } from './hand'
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

/**
 * Where the right hand rests: thumb on middle C (Sa), fingers over the notes up to G4 — every chord
 * is the inversion whose notes centre nearest E4 (key 16), the middle of that hand.
 */
const HAND_CENTRE = 16
/** At most this many notes in the hand; past it the perfect fifth is left out. */
const HAND_NOTES = 4
/** Lowest / highest key a chord shape takes (G3 / F#5): within the hand's reach, and on the treble staff. */
export const HARMONIUM_SHAPE_LOW = 7
export const HARMONIUM_SHAPE_HIGH = 30

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
 * The chord as a harmonium player's right hand takes it (the left pumps the bellows, so there is no
 * separate bass): the chord tones in close position — all within an octave, a triad under fingers
 * 1-3-5 — and of its inversions the one that sits nearest the resting hand (HAND_CENTRE), so the hand
 * barely moves from chord to chord: C = C E G, F = C F A, G = B D G, Am = C E A. Ties go to root
 * position. A slash chord keeps its bass at the bottom (C/E = E G C). A chord of five tones (a 9th, a
 * slash bass outside the chord) leaves out its perfect fifth.
 */
export function harmoniumVoicing(chord: ParsedChord): HarmoniumVoicing {
  const pcs = new Set(QUALITY_INTERVALS[chord.quality].map((i) => mod12(chord.rootPc + i)))
  if (chord.bassPc != null) pcs.add(chord.bassPc)
  const fifth = mod12(chord.rootPc + 7)
  if (pcs.size > HAND_NOTES && fifth !== chord.bassPc) pcs.delete(fifth)
  const notes = closeShape([...pcs], {
    rootPc: chord.rootPc,
    low: HARMONIUM_SHAPE_LOW,
    high: HARMONIUM_SHAPE_HIGH,
    centre: HAND_CENTRE,
    lowest: chord.bassPc,
  })
  return { notes }
}

/** The shape's notes as its staff writes them (treble clef alone), spelled by chord degree. */
export function harmoniumStaff(chord: ParsedChord, voicing: HarmoniumVoicing = harmoniumVoicing(chord)): SpelledNote[] {
  return spellNotes(chord, voicing.notes.map((k) => k + HARMONIUM_LOW))
}
