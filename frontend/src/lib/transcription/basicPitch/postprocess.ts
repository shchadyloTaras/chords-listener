/*
 * Copyright 2022 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * MODIFIED by Chords Listener: a port of `outputToNotesPoly` from @spotify/basic-pitch 1.0.1
 * (src/toMidi.ts). Same algorithm and results (see postprocess.test.ts, which runs both on the same
 * input), rewritten for flat Float32Array matrices: inferred onsets are computed on the fly, and the
 * "melodia trick" takes the global maximum from a lazily invalidated max-heap instead of rescanning
 * the whole matrix for every extracted note — O(n log n) instead of O(n²), so a whole song decodes
 * in well under a second.
 */
import { MIDI_OFFSET, N_PITCHES } from './constants.ts'

export interface PolyParams {
  /** minimum onset activation (after peak picking) that starts a note */
  onsetThresh: number
  /** minimum frame activation for a note to stay on; null = mean + std of the frames */
  frameThresh: number | null
  /** notes of `minNoteLen` frames or fewer are dropped */
  minNoteLen: number
  /** add onsets where the frame activation jumps */
  inferOnsets: boolean
  /** Hz bounds (null = the model's full range A0…C8) */
  maxFreq: number | null
  minFreq: number | null
  /** also extract sustained energy that has no detected onset (largest first) */
  melodiaTrick: boolean
  /** frames a note may drop below the frame threshold and still continue */
  energyTolerance: number
}

/** Reference defaults (basic-pitch's outputToNotesPoly). */
export const DEFAULT_POLY: PolyParams = {
  onsetThresh: 0.5,
  frameThresh: 0.3,
  minNoteLen: 5,
  inferOnsets: true,
  maxFreq: null,
  minFreq: null,
  melodiaTrick: true,
  energyTolerance: 11,
}

export interface RawNote {
  startFrame: number
  durationFrames: number
  pitchMidi: number
  amplitude: number
  /** true when the note came from a detected onset (false: melodia trick) */
  fromOnset: boolean
}

const P = N_PITCHES
const MAX_FREQ_IDX = P - 1

const hzToMidi = (hz: number): number => 12 * (Math.log2(hz) - Math.log2(440.0)) + 69

/** Copies of `frames`/`onsets` with bins outside [minFreq, maxFreq] zeroed (Array.prototype.fill semantics). */
function constrain(frames: Float32Array, onsets: Float32Array, nFrames: number, maxFreq: number | null, minFreq: number | null) {
  if (!maxFreq && !minFreq) return { frames, onsets }
  const f = frames.slice(0, nFrames * P)
  const o = onsets.slice(0, nFrames * P)
  const clampIdx = (x: number) => Math.min(P, Math.max(0, Math.trunc(x)))
  const hi = maxFreq ? clampIdx(hzToMidi(maxFreq) - MIDI_OFFSET) : P
  const lo = minFreq ? clampIdx(hzToMidi(minFreq) - MIDI_OFFSET) : 0
  for (let r = 0; r < nFrames; r++) {
    const base = r * P
    for (let c = 0; c < P; c++) {
      if (c >= hi || c < lo) {
        f[base + c] = 0
        o[base + c] = 0
      }
    }
  }
  return { frames: f, onsets: o }
}

function meanPlusStd(frames: Float32Array, nFrames: number): number {
  let sum = 0
  let sumSq = 0
  const count = nFrames * P
  for (let i = 0; i < count; i++) {
    const v = frames[i]
    sum += v
    sumSq += v * v
  }
  const mean = sum / count
  return mean + Math.sqrt((1 / (count - 1)) * (sumSq - (sum * sum) / count))
}

/**
 * Inferred onsets (reference `getInferredOnsets`, n_diff = 2): max(onsets, rescaled positive frame
 * increase), evaluated lazily in float64 exactly like the reference.
 */
function inferredOnsets(frames: Float32Array, onsets: Float32Array, nFrames: number, infer: boolean) {
  if (!infer) return (r: number, c: number): number => onsets[r * P + c]
  const diffAt = (r: number, c: number): number => {
    if (r < 2) return 0
    const v = frames[r * P + c]
    const d1 = v - frames[(r - 1) * P + c]
    const d2 = v - frames[(r - 2) * P + c]
    const d = Math.min(d1, d2)
    return d > 0 ? d : 0
  }
  let onsetMax = 0
  let diffMax = 0
  for (let r = 0; r < nFrames; r++) {
    for (let c = 0; c < P; c++) {
      const o = onsets[r * P + c]
      if (o > onsetMax) onsetMax = o
      const d = diffAt(r, c)
      if (d > diffMax) diffMax = d
    }
  }
  return (r: number, c: number): number => {
    const o = onsets[r * P + c]
    // the reference divides 0 by 0 here for silent input (NaN everywhere); treat it as "no inferred onsets"
    const d = diffMax > 0 ? (onsetMax * diffAt(r, c)) / diffMax : 0
    return Math.max(o, d)
  }
}

/** Binary max-heap of matrix cell indices ordered like the reference's argmax scan. */
class CellHeap {
  private readonly heap: Int32Array
  private size = 0
  private readonly vals: Float32Array

  constructor(vals: Float32Array, capacity: number) {
    this.vals = vals
    this.heap = new Int32Array(Math.max(1, capacity))
  }

  /** a before b: larger value; ties → earlier row; same row → later column (reference argmax order). */
  private before(a: number, b: number): boolean {
    const va = this.vals[a]
    const vb = this.vals[b]
    if (va !== vb) return va > vb
    const ra = (a / P) | 0
    const rb = (b / P) | 0
    return ra !== rb ? ra < rb : a > b
  }

  push(cell: number): void {
    const h = this.heap
    let i = this.size++
    h[i] = cell
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.before(h[i], h[parent])) break
      const tmp = h[i]
      h[i] = h[parent]
      h[parent] = tmp
      i = parent
    }
  }

  pop(): number {
    const h = this.heap
    const top = h[0]
    const last = h[--this.size]
    if (this.size > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let best = i
        if (l < this.size && this.before(h[l], h[best])) best = l
        if (r < this.size && this.before(h[r], h[best])) best = r
        if (best === i) break
        const tmp = h[i]
        h[i] = h[best]
        h[best] = tmp
        i = best
      }
    }
    return top
  }

  get length(): number {
    return this.size
  }
}

/**
 * Decodes note activations into note events (reference `outputToNotesPoly`).
 * `frames` / `onsets`: row-major [nFrames × 88] activations in 0..1. Inputs are not modified.
 * Notes come out in the reference's order (onset notes from the end of the song backwards, then
 * melodia-trick notes by decreasing energy).
 */
export function outputToNotesPoly(
  framesIn: Float32Array,
  onsetsIn: Float32Array,
  nFrames: number,
  params: Partial<PolyParams> = {},
): RawNote[] {
  const p: PolyParams = { ...DEFAULT_POLY, ...params }
  if (nFrames <= 0) return []
  const frameThresh = p.frameThresh ?? meanPlusStd(framesIn, nFrames)
  const { frames, onsets } = constrain(framesIn, onsetsIn, nFrames, p.maxFreq, p.minFreq)
  const inferred = inferredOnsets(frames, onsets, nFrames, p.inferOnsets)

  // peak picking along time (scipy argrelmax, order 1) + onset threshold, in reference order:
  // rows descending, columns descending
  const remaining = frames.slice(0, nFrames * P)
  const notes: RawNote[] = []
  const tol = p.energyTolerance
  for (let row = nFrames - 1; row >= 0; row--) {
    for (let col = P - 1; col >= 0; col--) {
      const v = inferred(row, col)
      if (!(v > p.onsetThresh)) continue
      if (row > 0 && !(v > inferred(row - 1, col))) continue
      if (row < nFrames - 1 && !(v > inferred(row + 1, col))) continue
      if (row >= nFrames - 1) continue
      // follow the note while its frame activation stays above the threshold (with tolerance)
      let i = row + 1
      let k = 0
      while (i < nFrames - 1 && k < tol) {
        if (remaining[i * P + col] < frameThresh) k += 1
        else k = 0
        i += 1
      }
      i -= k
      if (i - row <= p.minNoteLen) continue
      let sum = 0
      for (let j = row; j < i; j++) {
        const base = j * P
        remaining[base + col] = 0
        if (col < MAX_FREQ_IDX) remaining[base + col + 1] = 0
        if (col > 0) remaining[base + col - 1] = 0
      }
      for (let j = row; j < i; j++) sum += frames[j * P + col]
      notes.push({ startFrame: row, durationFrames: i - row, pitchMidi: col + MIDI_OFFSET, amplitude: sum / (i - row), fromOnset: true })
    }
  }

  if (!p.melodiaTrick) return notes

  let candidates = 0
  for (let i = 0; i < nFrames * P; i++) if (remaining[i] > frameThresh) candidates++
  const heap = new CellHeap(frames, candidates)
  for (let i = 0; i < nFrames * P; i++) if (remaining[i] > frameThresh) heap.push(i)

  while (heap.length) {
    const cell = heap.pop()
    // stale: zeroed by an earlier note (cells only ever drop to 0)
    if (remaining[cell] !== frames[cell]) continue
    const iMid = (cell / P) | 0
    const col = cell - iMid * P
    remaining[cell] = 0
    const clear = (r: number) => {
      const base = r * P
      remaining[base + col] = 0
      if (col < MAX_FREQ_IDX) remaining[base + col + 1] = 0
      if (col > 0) remaining[base + col - 1] = 0
    }
    // forward pass
    let i = iMid + 1
    let k = 0
    while (i < nFrames - 1 && k < tol) {
      if (remaining[i * P + col] < frameThresh) k += 1
      else k = 0
      clear(i)
      i += 1
    }
    const iEnd = i - 1 - k
    // backward pass
    i = iMid - 1
    k = 0
    while (i > 0 && k < tol) {
      if (remaining[i * P + col] < frameThresh) k += 1
      else k = 0
      clear(i)
      i -= 1
    }
    const iStart = i + 1 + k
    if (iEnd - iStart <= p.minNoteLen) continue
    let sum = 0
    for (let j = iStart; j < iEnd; j++) sum += frames[j * P + col]
    notes.push({
      startFrame: iStart,
      durationFrames: iEnd - iStart,
      pitchMidi: col + MIDI_OFFSET,
      amplitude: sum / (iEnd - iStart),
      fromOnset: false,
    })
  }
  return notes
}
