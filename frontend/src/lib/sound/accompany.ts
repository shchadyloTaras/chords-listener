// Play-along: the selected instrument accompanies the song, each in its own way, on the song's beats.
// Pure: turns the displayed chords and the beat grid into timed steps (song seconds) of the very
// notes each chord's diagram shows (the chord sound's notes); lib/sound/accompanyRuntime.ts plays
// them in sync with the player.
//
//   guitar / ukulele  strum: down on every beat, up on the "and" of every beat but the first
//                     (D DU DU DU), the downbeat strongest, an upstroke only the top strings
//   bass              the root on the downbeat and wherever the chord changes, the fifth on beat 3
//   piano             as pianists comp from a chord chart: the whole chord (left-hand bass + right
//                     hand) on beats 1 and 3 and at every change, the right hand alone on 2 and 4;
//                     in 3/4 a waltz — the bass alone on 1, the right hand on 2 and 3
//   harmonium         the chord's shape pressed when the chord comes and held until it changes
//   handpan           the bass field on the downbeat and at every change, the chord's other fields
//                     in turn on the other beats and on every "and"
//   sopilka / flute   one voice, as a melody player outlines the harmony: the diagram's arpeggio a
//                     note per beat, from its first note on the downbeat and at every change, each
//                     blown until a breath before the next beat

import type { Instrument } from '../../store'
import type { PulseGrid } from '../tempo'
import type { NoteEvent } from './chordNotes'

export interface AccompChord {
  start: number
  end: number
  /** display label (what the diagrams show); "N" for no chord */
  label: string
}

export interface AccompStep {
  /** song time (s) the step lands on */
  time: number
  label: string
  /** "all": cuts what the accompaniment still holds; "same": only re-strikes the same notes */
  cut: 'all' | 'same'
  notes: NoteEvent[]
}

/** The diagram's notes of a chord on the instrument (the chord sound's), [] when it has none. */
export type ChordNotesFn = (label: string) => NoteEvent[]

/** A chord detected this long (s) after a beat still belongs to that beat. */
export const BEAT_SNAP = 0.08
/** No "and" between beats further apart than this (s): a pause, a tempo hole. */
const MAX_BEAT_GAP = 1.5
/** The harmonium lifts its hand this long (s) before the next chord. */
export const HARMONIUM_LIFT = 0.04
/** The gap (s) between the strings of an upstroke (faster than a downstroke). */
const UP_GAP = 0.012
/** Strings an upstroke reaches (the top ones). */
const UP_STRINGS = 4
/** How long the piano's keys stay down on a step (s): the next chord cuts it anyway. */
export const PIANO_STEP_HOLD = 1.6
/** A wind player tongues the next note: the breath stops this long (s) before the next beat. */
export const WIND_BREATH = 0.05
/** The longest a wind note is held in the play-along (s): over a long pause the player stops. */
const WIND_MAX_HOLD = 2.4
/** The play-along offset setting's range and step (ms; positive = the instrument plays later). */
export const PLAY_ALONG_OFFSET_LIMIT = 150
export const ALONG_OFFSET_STEP = 5

/** The offset setting as used: a multiple of the step within the range (0 for anything odd). */
export function clampAlongOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-PLAY_ALONG_OFFSET_LIMIT, Math.min(PLAY_ALONG_OFFSET_LIMIT, Math.round(ms / ALONG_OFFSET_STEP) * ALONG_OFFSET_STEP)) || 0
}

interface Beat {
  time: number
  pos: number
  /** the next beat's time (NaN for the last) */
  next: number
  /** index into the chords of the chord on this beat, -1 = none */
  chord: number
  /** a new chord starts on this beat */
  change: boolean
}

const scale = (notes: NoteEvent[], k: number): NoteEvent[] => notes.map((n) => ({ ...n, velocity: Math.min(1, n.velocity * k) }))

/** Chord index sounding at `t` (chords ascending, non-overlapping), -1 = none / "N". */
function chordAt(chords: readonly AccompChord[], t: number): number {
  let lo = 0
  let hi = chords.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chords[mid].start <= t) lo = mid + 1
    else hi = mid - 1
  }
  const i = lo - 1
  return i >= 0 && t < chords[i].end && chords[i].label !== 'N' ? i : -1
}

function beatsOf(chords: readonly AccompChord[], grid: PulseGrid): Beat[] {
  const out: Beat[] = []
  const { times, pos } = grid
  for (let i = 0; i < times.length; i++) {
    const chord = chordAt(chords, times[i] + BEAT_SNAP)
    const prev = out[out.length - 1]
    out.push({
      time: times[i],
      pos: pos[i] ?? 0,
      next: i + 1 < times.length ? times[i + 1] : NaN,
      chord,
      change: chord >= 0 && (!prev || prev.chord < 0 || chords[prev.chord].label !== chords[chord].label),
    })
  }
  return out
}

/** The "and" after a beat, when the next beat is near enough. */
function andOf(b: Beat): number | null {
  const gap = b.next - b.time
  return gap > 0 && gap < MAX_BEAT_GAP ? b.time + gap / 2 : null
}

/** An upstroke: the top strings of the diagram's strum, high → low, faster and softer. */
function upstroke(down: NoteEvent[]): NoteEvent[] {
  const top = [...down].sort((a, b) => a.target - b.target).slice(-UP_STRINGS).reverse()
  return top.map((n, i) => ({ ...n, offset: i * UP_GAP, velocity: Math.min(1, n.velocity * 0.62) }))
}

function strum(beats: Beat[], chords: readonly AccompChord[], notesFor: ChordNotesFn): AccompStep[] {
  const steps: AccompStep[] = []
  for (const b of beats) {
    if (b.chord < 0) continue
    const label = chords[b.chord].label
    const down = notesFor(label)
    if (!down.length) continue
    steps.push({ time: b.time, label, cut: 'all', notes: scale(down, b.pos === 0 ? 1 : 0.82) })
    const and = andOf(b)
    if (b.pos !== 0 && and != null && chordAt(chords, and) === b.chord) steps.push({ time: and, label, cut: 'same', notes: upstroke(down) })
  }
  return steps
}

function bass(beats: Beat[], chords: readonly AccompChord[], notesFor: ChordNotesFn, meter: number): AccompStep[] {
  const steps: AccompStep[] = []
  for (const b of beats) {
    if (b.chord < 0) continue
    const third = meter >= 4 && b.pos === 2
    if (!(b.change || b.pos === 0 || third)) continue
    const label = chords[b.chord].label
    const shape = notesFor(label)
    if (!shape.length) continue
    const root = shape[0]
    const fifth = third && !b.change ? (shape.find((n) => n.midi - root.midi === 7) ?? shape.find((n) => n.midi - root.midi === 12) ?? root) : root
    steps.push({ time: b.time, label, cut: 'all', notes: [{ ...fifth, offset: 0, velocity: fifth === root ? (b.pos === 0 ? 0.9 : 0.82) : 0.76 }] })
  }
  return steps
}

function piano(beats: Beat[], chords: readonly AccompChord[], notesFor: ChordNotesFn, meter: number): AccompStep[] {
  const steps: AccompStep[] = []
  const waltz = meter === 3
  for (const b of beats) {
    if (b.chord < 0) continue
    const label = chords[b.chord].label
    const all = notesFor(label).map((n) => ({ ...n, hold: PIANO_STEP_HOLD }))
    if (all.length < 2) continue
    // the first note is the left hand's bass, a hair before the right hand
    const bass = [{ ...all[0], offset: 0 }]
    const right = all.slice(1).map((n) => ({ ...n, offset: Math.max(0, n.offset - all[1].offset) }))
    const notes = waltz ? (b.pos === 0 ? bass : b.change ? all : right) : b.change || b.pos === 0 || (meter >= 4 && b.pos === 2) ? all : right
    steps.push({ time: b.time, label, cut: b.change ? 'all' : 'same', notes })
  }
  return steps
}

function harmonium(beats: Beat[], chords: readonly AccompChord[], notesFor: ChordNotesFn): AccompStep[] {
  const steps: AccompStep[] = []
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]
    if (!b.change) continue
    // held until the beat the chord changes on (or the chord ends)
    let j = i + 1
    while (j < beats.length && beats[j].chord === b.chord) j++
    const chord = chords[b.chord]
    const until = j < beats.length ? Math.min(beats[j].time, chord.end) : chord.end
    const hold = until - b.time - HARMONIUM_LIFT
    const shape = notesFor(chord.label)
    if (!shape.length || hold <= 0.05) continue
    steps.push({ time: b.time, label: chord.label, cut: 'all', notes: shape.map((n) => ({ ...n, offset: 0, hold })) })
  }
  return steps
}

function handpan(beats: Beat[], chords: readonly AccompChord[], notesFor: ChordNotesFn): AccompStep[] {
  const steps: AccompStep[] = []
  let turn = 0
  for (const b of beats) {
    if (b.chord < 0) continue
    const label = chords[b.chord].label
    const fields = notesFor(label)
    if (!fields.length) continue
    const [low, ...rest] = fields
    const hit = (n: NoteEvent, velocity: number): NoteEvent => ({ ...n, offset: 0, velocity })
    if (b.change || b.pos === 0) {
      turn = 0
      steps.push({ time: b.time, label, cut: 'same', notes: [hit(low, 0.85)] })
    } else if (rest.length) steps.push({ time: b.time, label, cut: 'same', notes: [hit(rest[turn++ % rest.length], 0.66)] })
    const and = andOf(b)
    if (rest.length && and != null && chordAt(chords, and) === b.chord) steps.push({ time: and, label, cut: 'same', notes: [hit(rest[turn++ % rest.length], 0.5)] })
  }
  return steps
}

function wind(beats: Beat[], chords: readonly AccompChord[], notesFor: ChordNotesFn): AccompStep[] {
  const steps: AccompStep[] = []
  let turn = 0
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]
    if (b.chord < 0) continue
    const chord = chords[b.chord]
    const line = notesFor(chord.label)
    if (!line.length) continue
    if (b.change || b.pos === 0) turn = 0
    const n = line[turn++ % line.length]
    // blown until the next beat (or the chord's end), a breath before it
    const next = Number.isFinite(b.next) ? b.next : chord.end
    const hold = Math.min(next, chord.end, b.time + WIND_MAX_HOLD) - b.time - WIND_BREATH
    if (hold < 0.06) continue
    steps.push({ time: b.time, label: chord.label, cut: 'all', notes: [{ ...n, offset: 0, velocity: b.pos === 0 ? 0.9 : 0.8, hold }] })
  }
  return steps
}

/** The steps the instrument plays along the song (ascending time). */
export function accompanySteps(instrument: Instrument, chords: readonly AccompChord[], grid: PulseGrid, notesFor: ChordNotesFn): AccompStep[] {
  const beats = beatsOf(chords, grid)
  let steps: AccompStep[]
  switch (instrument) {
    case 'guitar':
    case 'ukulele':
      steps = strum(beats, chords, notesFor)
      break
    case 'bass':
      steps = bass(beats, chords, notesFor, grid.meter)
      break
    case 'piano':
      steps = piano(beats, chords, notesFor, grid.meter)
      break
    case 'harmonium':
      steps = harmonium(beats, chords, notesFor)
      break
    case 'handpan':
      steps = handpan(beats, chords, notesFor)
      break
    case 'sopilka':
    case 'flute':
      steps = wind(beats, chords, notesFor)
      break
  }
  return steps.sort((a, b) => a.time - b.time)
}
