// What the live keys show in chord mode — how a player accompanies the song from its chords, not
// the recording's transcribed notes:
// - the harmonium: each chord's shape (the diagram's, lib/diagrams/harmonium) pressed when the chord
//   comes and held, on the count, until the next chord;
// - the piano: the play-along's piano pattern (lib/sound/accompany.ts) — the left hand's bass and the
//   right hand's chord of the diagram (lib/diagrams/piano) on the song's beats, each key held until
//   the same hand strikes again or the chord ends.

import { HARMONIUM_LOW, harmoniumVoicing } from '../../../lib/diagrams/harmonium'
import { PIANO_RH_LOW } from '../../../lib/diagrams/piano'
import { parseChord } from '../../../lib/music/chord'
import type { DisplayChord } from '../../../lib/music/display'
import { accompanySteps, BEAT_SNAP } from '../../../lib/sound/accompany'
import { pianoChordNotes } from '../../../lib/sound/chordNotes'
import type { PulseGrid } from '../../../lib/tempo'
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

/** A key comes up this long (s) before the same hand strikes again, so repeated chords read as strikes. */
export const RESTRIKE_GAP = 0.06

/** End of the chord sounding at `t` (chords ascending), `t` itself where none does. */
function chordEnd(chords: readonly DisplayChord[], t: number): number {
  let lo = 0
  let hi = chords.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chords[mid].start <= t) lo = mid + 1
    else hi = mid - 1
  }
  const c = chords[lo - 1]
  return c && t < c.end ? c.end : t
}

/**
 * The piano pattern's notes as song notes: every step of the play-along pattern on the beat grid,
 * each key held until its hand (left = below F3) strikes again, or its chord ends. Written in the
 * original key like the harmonium's.
 */
export function pianoShapeNotes(chords: readonly DisplayChord[], grid: PulseGrid, transpose: number): NoteIndex {
  const real = chords.filter((c) => !c.isNone && c.end > c.start).map((c) => ({ start: c.start, end: c.end, label: c.label }))
  const steps = accompanySteps('piano', real, grid, pianoChordNotes)
  const left = (midi: number) => midi < PIANO_RH_LOW
  const start: number[] = []
  const end: number[] = []
  const midi: number[] = []
  const velocity: number[] = []
  steps.forEach((step, i) => {
    // the step's chord: the one it was snapped to (a chord detected a hair after the beat counts from it)
    const stop = chordEnd(chords, step.time + BEAT_SNAP)
    for (const n of step.notes) {
      const hand = left(n.midi)
      let until = stop
      for (let j = i + 1; j < steps.length && steps[j].time < until; j++) {
        if (steps[j].notes.some((m) => left(m.midi) === hand)) {
          until = steps[j].time
          break
        }
      }
      const t = step.time + n.offset
      const e = Math.max(t + 0.05, until - RESTRIKE_GAP)
      start.push(t)
      end.push(e)
      midi.push(n.midi - transpose)
      velocity.push(Math.min(1, Math.max(0.4, n.velocity + 0.2)))
    }
  })
  // song notes go by start time
  const order = start.map((_, i) => i).sort((a, b) => start[a] - start[b])
  return new NoteIndex({
    count: order.length,
    start: Float64Array.from(order.map((i) => start[i])),
    end: Float64Array.from(order.map((i) => end[i])),
    midi: Uint8Array.from(order.map((i) => midi[i])),
    velocity: Float32Array.from(order.map((i) => velocity[i])),
  })
}
