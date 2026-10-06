// Voice → written notes per measure: rests fill the gaps; notes are split at barlines, at chord
// changes (so a chord symbol always sits on a note or rest) and into note values that show the beat —
// with ties, dotted values where standard (dotted quarter, dotted eighth, dotted half), whole-measure
// rests and beams per beat.

import { DIV, type Measure } from './timeMap'
import type { BeamValue, NoteType, ScoreNote, WrittenNote } from './types'

const VALUES: readonly { ticks: number; type: NoteType; dots: number }[] = [
  { ticks: DIV * 4, type: 'whole', dots: 0 },
  { ticks: DIV * 3, type: 'half', dots: 1 },
  { ticks: DIV * 2, type: 'half', dots: 0 },
  { ticks: (DIV * 3) / 2, type: 'quarter', dots: 1 },
  { ticks: DIV, type: 'quarter', dots: 0 },
  { ticks: (DIV * 3) / 4, type: 'eighth', dots: 1 },
  { ticks: DIV / 2, type: 'eighth', dots: 0 },
  { ticks: DIV / 4, type: '16th', dots: 0 },
]

/** Middle of a bar that must stay visible (4/4: beat 3; 6/4: beat 4), or null (2/4, 3/4, 5/4…). */
function halfBar(beats: number): number | null {
  return beats >= 4 && beats % 2 === 0 ? (beats / 2) * DIV : null
}

/** Whether a note of `v` ticks may start at `p` in a measure of `len` ticks as one written value. */
export function noteFits(p: number, v: number, len: number, beats: number): boolean {
  if (p + v > len) return false
  const inBeat = p % DIV
  const half = halfBar(beats)
  const crossesHalf = half !== null && p < half && p + v > half
  switch (v) {
    case DIV / 4: // sixteenth
      return true
    case DIV / 2: // eighth: on an eighth, or the syncopated 16th–8th–16th inside a beat
      return inBeat % (DIV / 2) === 0 || inBeat === DIV / 4
    case (DIV * 3) / 4: // dotted eighth: inside one beat
      return inBeat === 0 || inBeat === DIV / 4
    case DIV: // quarter: on the beat, or syncopated (8th–4th–8th) without hiding the middle of the bar
      return inBeat === 0 || (inBeat === DIV / 2 && !crossesHalf)
    case (DIV * 3) / 2: // dotted quarter
      return (inBeat === 0 || inBeat === DIV / 2) && (!crossesHalf || p === 0)
    case DIV * 2: // half: on a beat; across the middle only as 4th–2nd–4th
      return inBeat === 0 && (!crossesHalf || (half !== null && p === half - DIV))
    case DIV * 3: // dotted half
      return inBeat === 0 && (p === 0 || !crossesHalf)
    case DIV * 4: // whole
      return p === 0 && len === DIV * 4
    default:
      return false
  }
}

/** Rests show every beat: no syncopated or dotted rests (a whole-measure rest is handled apart). */
export function restFits(p: number, v: number, len: number, beats: number): boolean {
  if (p + v > len) return false
  const inBeat = p % DIV
  const half = halfBar(beats)
  switch (v) {
    case DIV / 4:
      return true
    case DIV / 2:
      return inBeat % (DIV / 2) === 0
    case DIV:
      return inBeat === 0
    case DIV * 2:
      return inBeat === 0 && (half === null ? true : p % half === 0 && DIV * 2 <= half)
    default:
      return false
  }
}

/** Splits [p, p + d) of one note or rest into written values (greedy, longest first). */
export function splitValues(p: number, d: number, len: number, beats: number, rest: boolean): { start: number; ticks: number; type: NoteType; dots: number }[] {
  const out: { start: number; ticks: number; type: NoteType; dots: number }[] = []
  const fits = rest ? restFits : noteFits
  let pos = p
  let left = d
  while (left > 0) {
    const v = VALUES.find((x) => x.ticks <= left && Number.isInteger(x.ticks) && fits(pos, x.ticks, len, beats))
    if (!v) {
      // finer than a sixteenth cannot happen on the grid; write the rest as sixteenths
      out.push({ start: pos, ticks: 1, type: '16th', dots: 0 })
      pos += 1
      left -= 1
      continue
    }
    out.push({ start: pos, ticks: v.ticks, type: v.type, dots: v.dots })
    pos += v.ticks
    left -= v.ticks
  }
  return out
}

interface Span {
  start: number
  end: number
  note: ScoreNote | null
}

/**
 * Written notes of one voice for every measure. `harmonies` (absolute tick → displayed chord label)
 * are attached to the written note starting there; notes and rests are split at those ticks.
 */
export function notate(events: readonly ScoreNote[], measures: readonly Measure[], harmonies?: ReadonlyMap<number, string>): WrittenNote[][] {
  const sorted = [...events].filter((e) => e.end > e.start).sort((a, b) => a.start - b.start)
  const harmonyTicks = harmonies ? [...harmonies.keys()].sort((a, b) => a - b) : []
  let ei = 0
  let hi = 0
  return measures.map((m) => {
    const m0 = m.offset
    const m1 = m.offset + m.ticks
    while (ei < sorted.length && sorted[ei].end <= m0) ei++
    // spans covering the measure: notes and the rests between them
    const spans: Span[] = []
    let pos = m0
    for (let k = ei; k < sorted.length && sorted[k].start < m1; k++) {
      const e = sorted[k]
      const s = Math.max(m0, e.start)
      if (s > pos) spans.push({ start: pos, end: s, note: null })
      const end = Math.min(m1, e.end)
      if (end > Math.max(s, pos)) spans.push({ start: Math.max(s, pos), end, note: e })
      pos = Math.max(pos, end)
    }
    if (pos < m1) spans.push({ start: pos, end: m1, note: null })

    while (hi < harmonyTicks.length && harmonyTicks[hi] < m0) hi++
    const cuts: number[] = []
    for (let k = hi; k < harmonyTicks.length && harmonyTicks[k] < m1; k++) cuts.push(harmonyTicks[k])

    // a measure of rest without chord changes inside: one whole-measure rest
    if (spans.length === 1 && !spans[0].note && cuts.every((c) => c === m0)) {
      return [
        {
          start: 0,
          duration: m.ticks,
          type: null,
          dots: 0,
          pitches: [],
          velocity: 0,
          measureRest: true,
          tieStart: false,
          tieStop: false,
          beams: [],
          harmony: harmonies?.get(m0),
        },
      ]
    }

    const written: WrittenNote[] = []
    for (const span of spans) {
      const bounds = [span.start, ...cuts.filter((c) => c > span.start && c < span.end), span.end]
      for (let b = 0; b + 1 < bounds.length; b++) {
        const pieces = splitValues(bounds[b] - m0, bounds[b + 1] - bounds[b], m.ticks, m.beats, !span.note)
        pieces.forEach((piece) => {
          const absStart = m0 + piece.start
          const note = span.note
          const w: WrittenNote = {
            start: piece.start,
            duration: piece.ticks,
            type: piece.type,
            dots: piece.dots,
            pitches: note ? note.pitches : [],
            velocity: note ? note.velocity : 0,
            measureRest: false,
            tieStop: !!note && absStart > note.start,
            tieStart: !!note && absStart + piece.ticks < note.end,
            beams: [],
            harmony: harmonies?.get(absStart),
          }
          if (note?.spelling) w.spelling = note.spelling
          written.push(w)
        })
      }
    }
    beam(written)
    return written
  })
}

const BEAMABLE = new Set<NoteType>(['eighth', '16th'])

/** Beams eighths and sixteenths beat by beat; rests break a beam. */
export function beam(notes: WrittenNote[]): void {
  let group: WrittenNote[] = []
  const flush = () => {
    if (group.length >= 2) {
      const n = group.length
      group.forEach((w, i) => {
        w.beams = [i === 0 ? 'begin' : i === n - 1 ? 'end' : 'continue']
      })
      group.forEach((w, i) => {
        if (w.type !== '16th') return
        const prev = i > 0 && group[i - 1].type === '16th'
        const next = i < n - 1 && group[i + 1].type === '16th'
        const v: BeamValue = prev && next ? 'continue' : next ? 'begin' : prev ? 'end' : i === 0 ? 'forward hook' : 'backward hook'
        w.beams.push(v)
      })
    }
    group = []
  }
  let beat = -1
  for (const w of notes) {
    const b = Math.floor(w.start / DIV)
    const beamable = !!w.type && BEAMABLE.has(w.type) && w.pitches.length > 0
    if (!beamable || b !== beat) flush()
    beat = b
    if (beamable) group.push(w)
  }
  flush()
}
