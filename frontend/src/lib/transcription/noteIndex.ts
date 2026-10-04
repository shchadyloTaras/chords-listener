// Interval index over a song's notes for per-frame queries ("which notes sound at t?", "which notes
// fall into the next 3 s?"). Time is cut into fixed buckets; every note is listed in each bucket it
// overlaps, so a query touches only the notes near t — independent of how long the longest note is
// (a sorted-starts scan degrades to O(n) once one note is held for a minute). Built in O(n) with a
// counting sort; thousands of notes cost microseconds per frame.
import type { NoteArrays } from './compact.ts'

export const BUCKET_SECONDS = 0.5

export class NoteIndex {
  readonly notes: NoteArrays
  readonly count: number
  /** bucket b's notes: entries[offsets[b] .. offsets[b + 1]) (note indices, ascending) */
  private readonly offsets: Int32Array
  private readonly entries: Int32Array
  private readonly buckets: number
  /** lowest / highest MIDI note (0 when empty) */
  readonly minMidi: number
  readonly maxMidi: number

  constructor(notes: NoteArrays) {
    this.notes = notes
    this.count = notes.count
    let lastEnd = 0
    let minMidi = 127
    let maxMidi = 0
    for (let i = 0; i < notes.count; i++) {
      lastEnd = Math.max(lastEnd, notes.end[i])
      minMidi = Math.min(minMidi, notes.midi[i])
      maxMidi = Math.max(maxMidi, notes.midi[i])
    }
    this.minMidi = notes.count ? minMidi : 0
    this.maxMidi = notes.count ? maxMidi : 0
    this.buckets = Math.max(1, Math.floor(lastEnd / BUCKET_SECONDS) + 1)
    const counts = new Int32Array(this.buckets + 1)
    for (let i = 0; i < notes.count; i++) {
      const [b0, b1] = this.span(notes.start[i], notes.end[i])
      for (let b = b0; b <= b1; b++) counts[b + 1]++
    }
    for (let b = 0; b < this.buckets; b++) counts[b + 1] += counts[b]
    this.offsets = counts
    this.entries = new Int32Array(counts[this.buckets])
    const fill = counts.slice(0, this.buckets)
    for (let i = 0; i < notes.count; i++) {
      const [b0, b1] = this.span(notes.start[i], notes.end[i])
      for (let b = b0; b <= b1; b++) this.entries[fill[b]++] = i
    }
  }

  private bucketOf(t: number): number {
    return Math.min(this.buckets - 1, Math.max(0, Math.floor(t / BUCKET_SECONDS)))
  }

  /** first and last bucket a note [start, end) touches */
  private span(start: number, end: number): [number, number] {
    const b0 = this.bucketOf(start)
    // the end is exclusive: a note ending exactly on a bucket edge does not enter the next bucket
    const b1 = Math.max(b0, this.bucketOf(Math.max(start, end - 1e-9)))
    return [b0, b1]
  }

  /** Indices of the notes sounding at `t` (start ≤ t < end), ascending. Reuses `out`. */
  activeAt(t: number, out: number[] = []): number[] {
    out.length = 0
    if (!this.count || !Number.isFinite(t) || t < 0) return out
    const b = Math.floor(t / BUCKET_SECONDS)
    if (b >= this.buckets) return out
    const { start, end } = this.notes
    for (let k = this.offsets[b]; k < this.offsets[b + 1]; k++) {
      const i = this.entries[k]
      if (start[i] <= t && t < end[i]) out.push(i)
    }
    return out
  }

  /** Indices of the notes overlapping [t0, t1) (start < t1 and end > t0), each once, ascending per bucket. */
  inRange(t0: number, t1: number, out: number[] = []): number[] {
    out.length = 0
    if (!this.count || !(t1 > t0)) return out
    const b0 = this.bucketOf(Math.max(0, t0))
    const b1 = this.bucketOf(Math.max(0, t1 - 1e-9))
    if (t1 <= 0 || t0 >= this.buckets * BUCKET_SECONDS) return out
    const { start, end } = this.notes
    for (let b = b0; b <= b1; b++) {
      for (let k = this.offsets[b]; k < this.offsets[b + 1]; k++) {
        const i = this.entries[k]
        // report a note only in the first queried bucket it appears in
        if (b !== b0 && this.bucketOf(start[i]) !== b) continue
        if (start[i] < t1 && end[i] > t0) out.push(i)
      }
    }
    return out
  }

  /** Duration-weighted note presence per MIDI pitch (index = MIDI number, 0..127). */
  pitchWeights(): Float64Array {
    const w = new Float64Array(128)
    const { start, end, midi } = this.notes
    for (let i = 0; i < this.count; i++) w[midi[i]] += Math.min(4, end[i] - start[i])
    return w
  }
}
