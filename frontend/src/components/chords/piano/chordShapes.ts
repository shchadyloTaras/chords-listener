// The live harmonium plays the song the way a harmonium player accompanies it: each chord's shape
// (the diagram's, lib/diagrams/harmonium) pressed when the chord comes and held, on the count,
// until the next chord — not the recording's transcribed notes, which move like a pianist's.

import { HARMONIUM_LOW, harmoniumVoicing } from '../../../lib/diagrams/harmonium'
import { parseChord } from '../../../lib/music/chord'
import type { DisplayChord } from '../../../lib/music/display'
import { NoteIndex } from '../../../lib/transcription'

/** How hard the held keys light up (0..1). */
export const SHAPE_VELOCITY = 0.85

/**
 * The held chord shapes of the displayed chords as song notes. The labels are already transposed,
 * while the panel transposes song notes itself, so the shapes are written `transpose` lower.
 */
export function harmoniumShapeNotes(chords: readonly DisplayChord[], transpose: number): NoteIndex {
  const start: number[] = []
  const end: number[] = []
  const midi: number[] = []
  for (const c of chords) {
    if (c.isNone || !(c.end > c.start)) continue
    const parsed = parseChord(c.label)
    if (!parsed) continue
    for (const k of harmoniumVoicing(parsed).notes) {
      start.push(c.start)
      end.push(c.end)
      midi.push(HARMONIUM_LOW + k - transpose)
    }
  }
  const count = start.length
  return new NoteIndex({
    count,
    start: Float64Array.from(start),
    end: Float64Array.from(end),
    midi: Uint8Array.from(midi),
    velocity: new Float32Array(count).fill(SHAPE_VELOCITY),
  })
}
