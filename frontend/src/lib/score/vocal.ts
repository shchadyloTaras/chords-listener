// The sung melody as one monophonic voice: onsets and offsets on the grid, overlaps resolved, gaps
// shorter than an eighth absorbed by the note before (legato), real rests (≥ 1/8) kept — so every
// written duration stays within half a grid step (+ < 1/8 for a closed gap) of what was sung.

import { DIV, quantizeSpan, type TimeMap } from './timeMap'
import type { ScoreNote } from './types'

/** [start s, end s, MIDI, velocity] rows (VocalNotes / TrackNotes layout). */
export type NoteRow = readonly [number, number, number, number]

export interface VocalOptions {
  /** grid step in ticks: 1 = sixteenths, 2 = eighths */
  step: number
  /** semitones added to every pitch */
  transpose?: number
  /** shortest rest kept, ticks (default an eighth) */
  minRest?: number
  /** notes shorter than this (s) are dropped (default 50 ms) */
  minDuration?: number
  /** ornaments: notes shorter than this share of a sixteenth (≤ 130 ms) next to another note are absorbed (default 0.55, 0 = off) */
  ornament?: number
}

/** Ticks an onset may travel further to sit on an eighth rather than an odd sixteenth. */
const VOCAL_BIAS = 0.2
/** Neighbours closer than this (s) are "adjacent". */
const ADJACENT = 0.06

interface Timed {
  start: number
  end: number
  midi: number
  velocity: number
}

/**
 * Merges very short notes (slides into a note, fall-offs, pitch-tracker blips) into the adjacent
 * neighbour nearest in pitch: into the previous one (it lasts longer) or the next one (it starts earlier).
 */
export function absorbOrnaments<T extends Timed>(notes: readonly T[], map: TimeMap, share: number): T[] {
  if (!(share > 0)) return notes.map((n) => ({ ...n }))
  const out = notes.map((n) => ({ ...n }))
  const sixteenth = (t: number) => {
    const k = map.toTicks(t)
    return Math.max(0.02, map.toSeconds(k + 1) - map.toSeconds(k))
  }
  for (let i = 0; i < out.length; i++) {
    const n = out[i]
    const limit = Math.min(0.13, share * sixteenth(n.start))
    if (n.end - n.start >= limit) continue
    const prev = i > 0 ? out[i - 1] : null
    const next = i + 1 < out.length ? out[i + 1] : null
    const toPrev = prev && n.start - prev.end <= ADJACENT
    const toNext = next && next.start - n.end <= ADJACENT
    if (!toPrev && !toNext) continue
    const intoPrev = toPrev && (!toNext || Math.abs(n.midi - prev.midi) <= Math.abs(n.midi - (next as T).midi))
    if (intoPrev && prev) prev.end = n.end
    else if (next) next.start = n.start
    out.splice(i, 1)
    i--
  }
  return out
}

interface Sung {
  start: number
  end: number
  midi: number
  velocity: number
  qs: number
  qe: number
}

export function quantizeVocal(rows: readonly NoteRow[], map: TimeMap, opts: VocalOptions): ScoreNote[] {
  const step = Math.max(1, Math.round(opts.step))
  const minRest = opts.minRest ?? DIV / 2
  const minDuration = opts.minDuration ?? 0.05
  const transpose = Math.round(opts.transpose ?? 0)
  const total = map.totalTicks

  // 1. clean, sorted, monophonic (in seconds)
  const notes = rows
    .filter(([s, e, m]) => Number.isFinite(s) && Number.isFinite(e) && Number.isFinite(m) && e - s >= minDuration)
    .map(([s, e, m, v]) => ({ start: s, end: e, midi: Math.round(m), velocity: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8 }))
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const mono: typeof notes = []
  for (const n of notes) {
    const prev = mono[mono.length - 1]
    if (prev && n.start < prev.end) {
      if (n.start - prev.start < 0.02) {
        // the same onset twice: keep the longer note
        if (n.end - n.start > prev.end - prev.start) mono[mono.length - 1] = n
        continue
      }
      prev.end = n.start
    }
    mono.push({ ...n })
  }

  // 2. slides and ornaments (much shorter than a sixteenth, right next to another note) are not
  //    written as notes of their own: their time goes to the neighbour closer in pitch
  const sung = absorbOrnaments(mono, map, opts.ornament ?? 0.55)

  // 3. onto the grid; colliding onsets move to the next free step or the shorter note goes
  const out: Sung[] = []
  for (const n of sung) {
    const span = quantizeSpan(map, n.start, n.end, step, VOCAL_BIAS)
    let qs = span.qs
    if (qs >= total || span.rawEnd <= 0) continue
    qs = Math.max(0, qs)
    const qe = Math.min(total, Math.max(span.qe, qs + step))
    const prev = out[out.length - 1]
    if (prev && qs <= prev.qs) {
      const shifted = prev.qs + step
      if (shifted < qe && shifted < total) qs = shifted
      else {
        if (n.end - n.start > prev.end - prev.start) out[out.length - 1] = { ...n, qs: prev.qs, qe: Math.max(qe, prev.qs + step) }
        continue
      }
    }
    out.push({ ...n, qs, qe })
  }

  // 4. no overlaps; short gaps closed by the previous note
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]
    const next = out[i + 1]
    if (!next) break
    if (cur.qe > next.qs) cur.qe = next.qs
    const gap = next.qs - cur.qe
    if (gap > 0 && gap < minRest) cur.qe = next.qs
  }

  return out
    .filter((n) => n.qe > n.qs)
    .map((n) => ({ start: n.qs, end: n.qe, pitches: [clampMidi(n.midi + transpose)], velocity: n.velocity }))
}

function clampMidi(m: number): number {
  return Math.min(108, Math.max(21, m))
}

/** Median pitch of a voice (for the clef choice), null when empty. */
export function medianPitch(notes: readonly ScoreNote[]): number | null {
  const ps = notes.flatMap((n) => n.pitches).sort((a, b) => a - b)
  if (!ps.length) return null
  const m = ps.length >> 1
  return ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2
}
