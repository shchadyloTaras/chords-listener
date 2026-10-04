// Piano arrangement of the transcribed instrument notes (Basic Pitch): ghost notes dropped, onsets and
// offsets on the grid, the two hands split around middle C by a smooth adaptive split point, notes
// with the same onset in a hand written as a chord (one voice per hand, at most 4 notes, outer voices
// kept), each chord lasting until its notes end or the hand's next onset.

import { DIV, quantizeSpan, type TimeMap } from './timeMap'
import type { ScoreNote } from './types'
import type { NoteRow } from './vocal'

export interface PianoOptions {
  /** grid step in ticks: 1 = sixteenths, 2 = eighths */
  step: number
  transpose?: number
  /** fewer, longer, louder notes */
  simplified?: boolean
  /**
   * Sung notes to remove from a transcription of the full mix (Basic Pitch hears the voice too);
   * leave empty when the notes come from the instruments stem.
   */
  vocals?: readonly NoteRow[] | null
}

export interface PianoHands {
  rh: ScoreNote[]
  lh: ScoreNote[]
  /** split point per beat (MIDI: notes ≥ split go to the right hand) */
  splits: number[]
}

/** Tunables (exported for tests / tooling). */
export const PIANO = {
  /** notes weaker than this (0..1, relative to the song) are ghost notes */
  minVelocity: 0.3,
  minVelocitySimple: 0.42,
  /** notes shorter than this (s) are ghost notes */
  minDuration: 0.09,
  minDurationSimple: 0.14,
  /** a note weaker than this share of the loudest note of its chord is dropped (overtones, bleed) */
  relativeVelocity: 0.4,
  relativeVelocitySimple: 0.55,
  /** notes per hand and chord */
  maxNotes: 4,
  maxNotesRhSimple: 3,
  maxNotesLhSimple: 2,
  /** lower notes are written an octave higher (A1; C2 when simplified) */
  lowest: 33,
  lowestSimple: 36,
  /** candidate split points (MIDI) */
  splitLow: 48,
  splitHigh: 72,
}

/** Notes whose onsets are this close (s) were struck together (the transcription jitters a little). */
const TOGETHER = 0.06
/** Ticks an onset may travel further to sit on an eighth (see quantizeSpan). */
const ONSET_BIAS = 0.1

/** Gives notes struck together the same onset (the loudest note's), so they quantize into one chord. */
export function alignOnsets(notes: { start: number; end: number; velocity: number }[]): void {
  notes.sort((a, b) => a.start - b.start)
  for (let i = 0; i < notes.length; ) {
    let j = i + 1
    while (j < notes.length && notes[j].start - notes[i].start <= TOGETHER) j++
    if (j - i > 1) {
      let loud = i
      for (let k = i + 1; k < j; k++) if (notes[k].velocity > notes[loud].velocity) loud = k
      const at = notes[loud].start
      for (let k = i; k < j; k++) {
        const len = notes[k].end - notes[k].start
        notes[k].start = at
        notes[k].end = Math.max(notes[k].end, at + Math.min(len, 0.05))
      }
    }
    i = j
  }
}

interface QNote {
  midi: number
  velocity: number
  qs: number
  qe: number
}

const SPLIT_CENTER = 60

/**
 * Cost of a split point for one beat (lower = better). `onsets`: pitches starting in the beat;
 * `sounding`: pitches sounding in it (incl. held notes) — what each hand has to hold at once.
 */
function sliceCost(onsets: readonly number[], sounding: readonly number[], split: number): number {
  let cost = Math.abs(split - SPLIT_CENTER) * 0.04
  if (!sounding.length) return cost
  // the split should fall into a gap between the pitch clusters
  let below = -Infinity
  let above = Infinity
  let lhLo = Infinity
  let rhHi = -Infinity
  for (const p of sounding) {
    if (p < split) {
      below = Math.max(below, p)
      lhLo = Math.min(lhLo, p)
    } else {
      above = Math.min(above, p)
      rhHi = Math.max(rhHi, p)
    }
  }
  cost -= Math.min(12, above - below) / 12
  // a hand holds about an octave at most
  if (below - lhLo > 12) cost += (below - lhLo - 12) * 0.5
  if (rhHi - above > 12) cost += (rhHi - above - 12) * 0.5
  // ledger lines: high notes in the bass clef, low notes in the treble clef
  for (const p of onsets) {
    if (p < split) {
      if (p > 64) cost += (p - 64) * 0.15
    } else if (p < 55) cost += (55 - p) * 0.15
  }
  return cost
}

/** Beats a held note keeps constraining the hand split. */
const HOLD_BEATS = 8

/**
 * Split point per beat: a Viterbi path over candidate splits that prefers gaps between pitch clusters,
 * playable hand spans and few ledger lines, stays near middle C and moves smoothly.
 */
export function splitPoints(notes: readonly { midi: number; qs: number; qe?: number }[], beats: number): number[] {
  const lo = PIANO.splitLow
  const hi = PIANO.splitHigh
  const S = hi - lo + 1
  const n = Math.max(1, beats)
  const onsets: number[][] = Array.from({ length: n }, () => [])
  const sounding: number[][] = Array.from({ length: n }, () => [])
  for (const q of notes) {
    const b0 = Math.min(n - 1, Math.max(0, Math.floor(q.qs / DIV)))
    const b1 = Math.min(n - 1, b0 + HOLD_BEATS - 1, Math.max(b0, Math.floor(((q.qe ?? q.qs + 1) - 1) / DIV)))
    onsets[b0].push(q.midi)
    for (let b = b0; b <= b1; b++) sounding[b].push(q.midi)
  }
  const MOVE = 0.08
  let prev = new Float64Array(S)
  const back: Int16Array[] = []
  for (let b = 0; b < n; b++) {
    const cur = new Float64Array(S)
    const from = new Int16Array(S)
    for (let s = 0; s < S; s++) {
      const emit = sliceCost(onsets[b], sounding[b], lo + s)
      if (b === 0) {
        cur[s] = emit
        continue
      }
      let best = Infinity
      let arg = 0
      for (let r = 0; r < S; r++) {
        const c = prev[r] + Math.abs(r - s) * MOVE
        if (c < best) {
          best = c
          arg = r
        }
      }
      cur[s] = best + emit
      from[s] = arg
    }
    back.push(from)
    prev = cur
  }
  let s = 0
  for (let k = 1; k < S; k++) if (prev[k] < prev[s] || (prev[k] === prev[s] && Math.abs(lo + k - SPLIT_CENTER) < Math.abs(lo + s - SPLIT_CENTER))) s = k
  const out = new Array<number>(n)
  for (let b = n - 1; b >= 0; b--) {
    out[b] = lo + s
    s = back[b][s]
  }
  return out
}

/** Outer voices plus the loudest inner notes, at most `max` (ascending, unique). */
export function capChord(notes: readonly { midi: number; velocity: number }[], max: number): { midi: number; velocity: number }[] {
  const byPitch = new Map<number, { midi: number; velocity: number }>()
  for (const n of notes) {
    const prev = byPitch.get(n.midi)
    if (!prev || n.velocity > prev.velocity) byPitch.set(n.midi, n)
  }
  const sorted = [...byPitch.values()].sort((a, b) => a.midi - b.midi)
  if (sorted.length <= max) return sorted
  if (max <= 1) return [sorted[sorted.length - 1]]
  const inner = sorted
    .slice(1, -1)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, max - 2)
  return [sorted[0], ...inner, sorted[sorted.length - 1]].sort((a, b) => a.midi - b.midi)
}

function overlaps(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Drops transcribed notes that are the singer (same pitch or octave, mostly inside a sung note). */
function withoutVocals<T extends { start: number; end: number; midi: number }>(notes: T[], vocals: readonly NoteRow[]): T[] {
  if (!vocals.length) return notes
  const sung = [...vocals].sort((a, b) => a[0] - b[0])
  const starts = sung.map((r) => r[0])
  return notes.filter((n) => {
    // sung notes that may overlap n: those starting before n ends (scan back a little)
    let hi = 0
    let lo = starts.length
    while (hi < lo) {
      const mid = (hi + lo) >> 1
      if (starts[mid] < n.end) hi = mid + 1
      else lo = mid
    }
    const dur = n.end - n.start
    for (let i = hi - 1; i >= 0 && i >= hi - 12; i--) {
      const [s, e, m] = sung[i]
      if (e <= n.start) continue
      const d = Math.abs(n.midi - Math.round(m))
      if ((d === 0 || d === 12) && overlaps(n.start, n.end, s, e) >= 0.5 * dur) return false
    }
    return true
  })
}

export function arrangePiano(rows: readonly NoteRow[], map: TimeMap, opts: PianoOptions): PianoHands {
  const step = Math.max(1, Math.round(opts.step))
  const simple = !!opts.simplified
  const transpose = Math.round(opts.transpose ?? 0)
  const total = map.totalTicks
  const minVel = simple ? PIANO.minVelocitySimple : PIANO.minVelocity
  const minDur = simple ? PIANO.minDurationSimple : PIANO.minDuration

  let raw = rows
    .filter(([s, e, m, v]) => Number.isFinite(s) && Number.isFinite(e) && Number.isFinite(m) && e - s >= minDur && v >= minVel)
    .map(([s, e, m, v]) => ({ start: s, end: e, midi: Math.round(m), velocity: Math.min(1, v) }))
  if (opts.vocals?.length) raw = withoutVocals(raw, opts.vocals)
  alignOnsets(raw)

  // on the grid
  const qnotes: QNote[] = []
  const lowest = simple ? PIANO.lowestSimple : PIANO.lowest
  for (const n of raw) {
    let midi = n.midi + transpose
    // the bass guitar's lowest notes would hang 4+ ledger lines below the staff: an octave up
    while (midi < lowest) midi += 12
    if (midi < 21 || midi > 108) continue
    const span = quantizeSpan(map, n.start, n.end, step, ONSET_BIAS)
    const qs = Math.max(0, span.qs)
    if (qs >= total || span.rawEnd <= 0) continue
    const qe = Math.min(total, Math.max(qs + step, span.qe))
    qnotes.push({ midi, velocity: n.velocity, qs, qe })
  }

  // weak notes next to a loud one at the same onset are overtones / bleed
  const rel = simple ? PIANO.relativeVelocitySimple : PIANO.relativeVelocity
  const loudest = new Map<number, number>()
  for (const q of qnotes) loudest.set(q.qs, Math.max(loudest.get(q.qs) ?? 0, q.velocity))
  const kept = qnotes.filter((q) => q.velocity >= rel * (loudest.get(q.qs) ?? 0))

  const beats = Math.max(1, Math.ceil(total / DIV))
  const splits = splitPoints(kept, beats)
  const splitAt = (tick: number) => splits[Math.min(splits.length - 1, Math.max(0, Math.floor(tick / DIV)))]

  const hands: { rh: QNote[]; lh: QNote[] } = { rh: [], lh: [] }
  for (const q of kept) (q.midi >= splitAt(q.qs) ? hands.rh : hands.lh).push(q)

  // gaps closed between a chord and the hand's next onset: shorter than an eighth (a quarter when
  // simplified), or at most a quarter (half) of the time between the onsets
  const legatoGap = simple ? DIV : DIV / 2
  const legatoShare = simple ? 2 : 4
  const releaseGrid = simple ? DIV : DIV / 2
  const voice = (notes: QNote[], max: number): ScoreNote[] => {
    const byOnset = new Map<number, QNote[]>()
    for (const q of notes) {
      const g = byOnset.get(q.qs)
      if (g) g.push(q)
      else byOnset.set(q.qs, [q])
    }
    const onsets = [...byOnset.keys()].sort((a, b) => a - b)
    const out: ScoreNote[] = []
    onsets.forEach((qs, i) => {
      const group = byOnset.get(qs) as QNote[]
      const chord = capChord(group, max)
      const next = i + 1 < onsets.length ? onsets[i + 1] : total
      // a held chord lasts until its longest note ends, never past the hand's next onset
      let end = Math.min(next, Math.max(...group.map((q) => q.qe)))
      // released just before the next chord: written legato (no 16th rests between chords)
      const gap = next - end
      if (i + 1 < onsets.length && gap > 0 && (gap < legatoGap || gap * legatoShare <= next - qs)) end = next
      // released before a rest: the release is not worth a sixteenth of precision
      if (end < next) end = Math.min(next, Math.max(qs + step, Math.round(end / releaseGrid) * releaseGrid))
      out.push({
        start: qs,
        end: Math.max(end, Math.min(next, qs + step)),
        pitches: chord.map((c) => c.midi),
        velocity: Math.max(...chord.map((c) => c.velocity)),
      })
    })
    return simple ? mergeRepeats(out) : out
  }

  return {
    rh: voice(hands.rh, simple ? PIANO.maxNotesRhSimple : PIANO.maxNotes),
    lh: voice(hands.lh, simple ? PIANO.maxNotesLhSimple : PIANO.maxNotes),
    splits,
  }
}

/** Simplified: the same chord struck again right away within the beat is held instead. */
function mergeRepeats(notes: ScoreNote[]): ScoreNote[] {
  const out: ScoreNote[] = []
  for (const n of notes) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.end === n.start &&
      Math.floor(prev.start / DIV) === Math.floor(n.start / DIV) &&
      prev.pitches.length === n.pitches.length &&
      prev.pitches.every((p, i) => p === n.pitches[i])
    ) {
      prev.end = n.end
      prev.velocity = Math.max(prev.velocity, n.velocity)
      continue
    }
    out.push({ ...n, pitches: [...n.pitches] })
  }
  return out
}
