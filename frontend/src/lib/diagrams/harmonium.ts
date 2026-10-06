// The Indian hand harmonium's keyboard: 37 keys from C3 to C6 (three octaves and the top C, 22
// white + 15 black keys, the black ones grouped 2-3-2-3-2-3), and which of them a chord lights —
// exactly the notes the grand staff shows and the chord sound plays.

import type { ParsedChord } from '../music/chord'
import { BLACK_PCS, pianoVoicing } from './piano'
import { staffChord } from './staff'

export const HARMONIUM_KEYS = 37
/** MIDI note of key 0 (C3) */
export const HARMONIUM_LOW = 48
/** MIDI note of the last key (C6) */
export const HARMONIUM_HIGH = HARMONIUM_LOW + HARMONIUM_KEYS - 1
export const HARMONIUM_WHITES = 22

/** white-key index within the octave for each pitch class (black keys: the white key on their left) */
const WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

export interface HarmoniumVoicing {
  /** key indices 0..36 (0 = C3), ascending */
  notes: number[]
  /** key index of the bass note (slash bass or root), in the lowest octave */
  bass: number
}

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
 * The chord as the grand staff writes it, on the harmonium's keys: the bass (slash bass or root)
 * in the lowest octave, the right hand from middle C (the piano voicing, a slash bass left out).
 */
export function harmoniumVoicing(chord: ParsedChord): HarmoniumVoicing {
  const staff = staffChord(chord, pianoVoicing(chord))
  const bass = staff.bass.midi - HARMONIUM_LOW
  return { notes: [bass, ...staff.treble.map((n) => n.midi - HARMONIUM_LOW)], bass }
}
