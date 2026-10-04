// Piano voicing for a 2-octave keyboard (C … B, B): which keys to light for a chord.

import { QUALITY_INTERVALS, type ParsedChord } from '../music/chord'

export const PIANO_KEYS = 24

export interface PianoVoicing {
  /** key indices 0..23 (0 = C of the lower octave), ascending */
  notes: number[]
  /** key index of the bass note (slash bass or root) */
  bass: number
}

/** Black keys inside an octave. */
export const BLACK_PCS = new Set([1, 3, 6, 8, 10])

/**
 * Root-position voicing that fits in 2 octaves. A slash bass is placed lowest with the chord
 * stacked above it; notes that would overflow the keyboard are folded down an octave.
 */
export function pianoVoicing(chord: ParsedChord): PianoVoicing {
  const bassPc = chord.bassPc ?? chord.rootPc
  let rootKey = chord.rootPc
  if (chord.bassPc != null && rootKey <= bassPc) rootKey += 12
  const raw = QUALITY_INTERVALS[chord.quality].map((i) => rootKey + i)
  const fold = (k: number) => {
    let x = k
    while (x >= PIANO_KEYS) x -= 12
    return x
  }
  const notes = new Set<number>(raw.map(fold))
  if (chord.bassPc != null) notes.add(bassPc)
  return { notes: [...notes].sort((a, b) => a - b), bass: chord.bassPc != null ? bassPc : fold(rootKey) }
}
