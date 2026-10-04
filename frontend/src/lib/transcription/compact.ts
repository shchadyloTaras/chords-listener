// Compact storage format of a track's notes (TrackNotes, docs/SPEC.md) ⇄ the columnar arrays the
// live piano works with. The same limits are enforced by the server (PUT /api/tracks/{id}/notes).
import type { TrackNotes } from '../../types.ts'

export const NOTES_VERSION = 1
export const MAX_NOTES = 300_000
export const MIDI_LOW = 21
export const MIDI_HIGH = 108
/** notes may end at most this long after the track's duration (decoders differ slightly) */
export const END_TOLERANCE = 1

/** A note event in seconds (what the transcriber produces). */
export interface NoteEvent {
  midi: number
  start: number
  end: number
  /** 0..1 */
  velocity: number
}

/** Notes as parallel columns, sorted by start (then pitch). */
export interface NoteArrays {
  count: number
  start: Float64Array
  end: Float64Array
  midi: Uint8Array
  velocity: Float32Array
}

export class NotesFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotesFormatError'
  }
}

const ms = (t: number) => Math.round(t * 1000) / 1000

/** Sorted, rounded and validated TrackNotes from note events (invalid events are dropped). */
export function encodeNotes(events: readonly NoteEvent[], engine: string): TrackNotes {
  const rows: [number, number, number, number][] = []
  for (const e of events) {
    const start = ms(Math.max(0, e.start))
    const end = ms(e.end)
    const midi = Math.round(e.midi)
    const velocity = Math.round(Math.min(1, Math.max(0, e.velocity)) * 1000) / 1000
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue
    if (!(midi >= MIDI_LOW && midi <= MIDI_HIGH) || !Number.isFinite(velocity)) continue
    rows.push([start, end, midi, velocity])
  }
  rows.sort((a, b) => a[0] - b[0] || a[2] - b[2])
  if (rows.length > MAX_NOTES) rows.length = MAX_NOTES
  return { version: NOTES_VERSION, engine: engine.slice(0, 200), notes: rows }
}

/**
 * Validates a TrackNotes-shaped value (from the server or IndexedDB). Returns an English reason
 * when invalid, null when fine. `duration` (s) bounds the note ends when given.
 */
export function validateNotes(data: unknown, duration?: number): string | null {
  if (!data || typeof data !== 'object') return 'not an object'
  const d = data as Partial<TrackNotes>
  if (d.version !== NOTES_VERSION) return `unsupported version ${String(d.version)}`
  if (typeof d.engine !== 'string' || !d.engine || d.engine.length > 200) return 'engine must be a non-empty string'
  if (!Array.isArray(d.notes)) return 'notes must be an array'
  if (d.notes.length > MAX_NOTES) return `too many notes (max ${MAX_NOTES})`
  const maxEnd = duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration + END_TOLERANCE : Infinity
  for (let i = 0; i < d.notes.length; i++) {
    const row = d.notes[i] as unknown
    if (!Array.isArray(row) || row.length !== 4) return `notes[${i}] must be [start, end, midi, velocity]`
    const [start, end, midi, velocity] = row as number[]
    if (![start, end, midi, velocity].every((v) => typeof v === 'number' && Number.isFinite(v))) return `notes[${i}] has a non-finite value`
    if (!(start >= 0 && start < end && end <= maxEnd)) return `notes[${i}] has invalid times`
    if (!Number.isInteger(midi) || midi < MIDI_LOW || midi > MIDI_HIGH) return `notes[${i}] pitch must be ${MIDI_LOW}..${MIDI_HIGH}`
    if (velocity < 0 || velocity > 1) return `notes[${i}] velocity must be 0..1`
  }
  return null
}

/** Columnar arrays from TrackNotes (sorted by start). Throws NotesFormatError when invalid. */
export function decodeNotes(data: unknown, duration?: number): NoteArrays {
  const problem = validateNotes(data, duration)
  if (problem) throw new NotesFormatError(problem)
  const rows = [...(data as TrackNotes).notes].sort((a, b) => a[0] - b[0] || a[2] - b[2])
  const n = rows.length
  const out: NoteArrays = {
    count: n,
    start: new Float64Array(n),
    end: new Float64Array(n),
    midi: new Uint8Array(n),
    velocity: new Float32Array(n),
  }
  for (let i = 0; i < n; i++) {
    const [s, e, m, v] = rows[i]
    out.start[i] = s
    out.end[i] = e
    out.midi[i] = m
    out.velocity[i] = v
  }
  return out
}

/** Note events back from columns (tests, re-encoding). */
export function toEvents(a: NoteArrays): NoteEvent[] {
  return Array.from({ length: a.count }, (_, i) => ({ midi: a.midi[i], start: a.start[i], end: a.end[i], velocity: a.velocity[i] }))
}
