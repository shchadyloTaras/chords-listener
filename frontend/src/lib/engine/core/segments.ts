// Segment utilities: path -> segments, beat-aware change penalties, snapping chord
// changes to beats, merging and minimum-duration cleanup.

import { median, nearestDistance, nearestValue } from './util.ts'

export interface Segment {
  start: number
  end: number
  /** decoder state */
  state: number
  /** first frame (inclusive) */
  first: number
  /** last frame (exclusive) */
  last: number
  confidence: number
}

export const duration = (s: Segment): number => s.end - s.start

/**
 * Per-frame extra log-cost of a state change between frame t-1 and t: free close to a
 * beat, `halfBeat` close to an off-beat (eighth), `offBeat` elsewhere. Without beats,
 * and outside the tracked region, changes are free.
 */
export function changePenalties(T: number, fps: number, beats: readonly number[], offBeat: number, halfBeat: number,
  tolerance = 0.075): Float64Array {
  const pen = new Float64Array(T)
  if (beats.length < 2 || T === 0) return pen
  const mids: number[] = []
  const ibis: number[] = []
  for (let i = 1; i < beats.length; i++) {
    mids.push(0.5 * (beats[i - 1] + beats[i]))
    ibis.push(beats[i] - beats[i - 1])
  }
  const ibi = median(ibis)
  const tol = Math.min(tolerance, 0.3 * ibi)
  const first = beats[0] - ibi
  const last = beats[beats.length - 1] + ibi
  for (let t = 0; t < T; t++) {
    const time = (t - 0.5) / fps
    if (time < first || time > last) continue
    if (nearestDistance(beats, time) <= tol) pen[t] = 0
    else if (nearestDistance(mids, time) <= tol) pen[t] = halfBeat
    else pen[t] = offBeat
  }
  return pen
}

export function pathToSegments(path: Int32Array, fps: number, dur: number): Segment[] {
  const segs: Segment[] = []
  const T = path.length
  let s = 0
  for (let t = 1; t <= T; t++) {
    if (t < T && path[t] === path[s]) continue
    const t0 = s === 0 ? 0 : (s - 0.5) / fps
    const t1 = t === T ? dur : Math.min((t - 0.5) / fps, dur)
    if (t1 > t0) segs.push({ start: t0, end: t1, state: path[s], first: s, last: t, confidence: 0 })
    s = t
  }
  return segs
}

/** Move chord boundaries onto the nearest beat (or off-beat) when within `tolerance` seconds. */
export function snapBoundaries(segs: Segment[], beats: readonly number[], tolerance: number): Segment[] {
  if (segs.length < 2 || beats.length < 2) return segs
  const ibis: number[] = []
  const half: number[] = []
  for (let i = 1; i < beats.length; i++) {
    ibis.push(beats[i] - beats[i - 1])
    half.push(0.5 * (beats[i - 1] + beats[i]))
  }
  const tol = Math.min(tolerance, 0.3 * median(ibis))
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1]
    const b = segs[i]
    const t = b.start
    const db = nearestValue(beats, t)
    let next = t
    if (Math.abs(db - t) <= tol) next = db
    else {
      const dh = nearestValue(half, t)
      if (Math.abs(dh - t) <= tol * 0.7) next = dh
    }
    next = Math.min(Math.max(next, a.start), b.end)
    a.end = next
    b.start = next
  }
  return segs.filter((s) => s.end - s.start > 1e-6)
}

export function mergeEqual(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    const prev = out[out.length - 1]
    if (prev && prev.state === s.state) {
      const w0 = duration(prev)
      const w1 = duration(s)
      prev.confidence = (prev.confidence * w0 + s.confidence * w1) / Math.max(w0 + w1, 1e-9)
      prev.end = s.end
      prev.last = s.last
    } else {
      out.push({ ...s })
    }
  }
  return out
}

/**
 * Remove segments shorter than `minDur` by giving their span to the neighbour that explains
 * it best (`score(segment, candidateState)`), shortest first.
 */
export function absorbShort(segs: Segment[], minDur: number, score: (seg: Segment, state: number) => number): Segment[] {
  const out = segs.slice()
  while (out.length > 1) {
    let i = -1
    for (let k = 0; k < out.length; k++) {
      if (duration(out[k]) < minDur && (i < 0 || duration(out[k]) < duration(out[i]))) i = k
    }
    if (i < 0) break
    const s = out[i]
    let j = -1
    let best = -Infinity
    for (const n of [i - 1, i + 1]) {
      if (n < 0 || n >= out.length) continue
      const v = score(s, out[n].state)
      if (v > best) {
        best = v
        j = n
      }
    }
    const n = out[j]
    if (j < i) {
      n.end = s.end
      n.last = s.last
    } else {
      n.start = s.start
      n.first = s.first
    }
    out.splice(i, 1)
  }
  return out
}

/** Frame indices whose time lies in [a, b); the frame nearest the middle when none does. */
export function framesIn(T: number, fps: number, a: number, b: number): [number, number] {
  let lo = Math.max(0, Math.ceil(a * fps - 1e-9))
  let hi = Math.min(T, Math.ceil(b * fps - 1e-9))
  if (hi <= lo) {
    const mid = Math.min(T - 1, Math.max(0, Math.round(((a + b) / 2) * fps)))
    lo = mid
    hi = mid + 1
  }
  return [lo, hi]
}
