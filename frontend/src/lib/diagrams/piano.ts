// The piano as a pianist accompanies a song from its chords (docs/SPEC.md "Piano"): the left hand
// plays the bass — the slash bass, else the root — alone, in the bass register (E2–D#3); the right
// hand plays the chord in close position around middle C, the inversion nearest where it rests
// (within F3–C5, centred on E4: C = C E G, F = C F A, G = B D G), so it barely moves from chord to
// chord. A chord of four or more tones leaves out of the right hand the note the left already plays
// (7ths: 3-5-7), then the fifth (9ths: 3-7-9) — four notes stay only when a slash bass outside the
// chord leaves nothing to drop (C9/F#). The diagram shows the keys both hands use, C2–C5.

import { QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { mod12 } from '../music/notes'
import { closeShape } from './hand'

/** MIDI note of the diagram's key 0 (C2) and its number of keys (C2–C5). */
export const PIANO_LOW = 36
export const PIANO_KEYS = 37
/** The left hand's bass: the one note of its pitch class in E2–D#3. */
export const PIANO_LH_LOW = 40
/** The right hand's chord: every note within F3–C5, the shape averaging nearest E4. */
export const PIANO_RH_LOW = 53
export const PIANO_RH_HIGH = 72
const RH_CENTRE = 64
/** The right hand thins a bigger chord towards three notes (four at most). */
const RH_NOTES = 3

export interface PianoVoicing {
  /** keys lit by both hands (0 = C2), ascending */
  notes: number[]
  /** the left hand's key: the bass (slash bass or root) */
  bass: number
  /** the right hand's keys, ascending */
  right: number[]
}

/** Black keys inside an octave. */
export const BLACK_PCS = new Set([1, 3, 6, 8, 10])

/** Pitch classes the right hand plays: the chord's tones, thinned towards three (four at most). */
export function rightHandTones(chord: ParsedChord): number[] {
  const bassPc = chord.bassPc ?? chord.rootPc
  let tones = [...new Set(QUALITY_INTERVALS[chord.quality].map((i) => mod12(chord.rootPc + i)))]
  if (tones.length > RH_NOTES) tones = tones.filter((pc) => pc !== bassPc)
  const fifth = mod12(chord.rootPc + 7)
  if (tones.length > RH_NOTES && tones.includes(fifth)) tones = tones.filter((pc) => pc !== fifth)
  return tones
}

export function pianoVoicing(chord: ParsedChord): PianoVoicing {
  const bassPc = chord.bassPc ?? chord.rootPc
  const bass = PIANO_LH_LOW + mod12(bassPc - PIANO_LH_LOW) - PIANO_LOW
  const right = closeShape(rightHandTones(chord), { rootPc: chord.rootPc, low: PIANO_RH_LOW, high: PIANO_RH_HIGH, centre: RH_CENTRE }).map(
    (m) => m - PIANO_LOW,
  )
  return { notes: [bass, ...right].sort((a, b) => a - b), bass, right }
}
