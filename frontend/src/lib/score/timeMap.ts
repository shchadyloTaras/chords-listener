// Seconds ⇄ musical time. The score's measures are the chord sheet's bars (lib/music/bars
// buildBarGrid on the track's *effective* beats, i.e. after the ×½ / ×2 tempo correction), so bar N of
// the sheet is measure N of the score. Inside a bar, time is piecewise linear between its beat
// boundaries: a beat is always DIV ticks long, however long it lasts in seconds.

import type { BarFrame } from '../music/bars'

/** MusicXML divisions per quarter note: one tick = a sixteenth. */
export const DIV = 4

export interface Measure {
  /** 0-based, equal to the chord sheet's bar index (a split last bar adds one measure at the end) */
  index: number
  /** MusicXML measure number ("0" for a pickup) */
  number: string
  /** seconds */
  start: number
  end: number
  /** beat boundary times [start, …, end] (beats + 1 values) */
  boundaries: number[]
  /** quarter-note beats in this measure */
  beats: number
  /** first tick of the measure from the start of the piece */
  offset: number
  /** ticks in the measure (beats × DIV) */
  ticks: number
  /** short first bar (anacrusis): written as an implicit measure */
  pickup: boolean
}

export interface TimeMap {
  measures: Measure[]
  /** beats per regular bar */
  timeSignature: number
  totalTicks: number
  /** seconds → ticks (fractional; extrapolated before the first / after the last beat) */
  toTicks(t: number): number
  /** ticks (may be fractional) → seconds */
  toSeconds(tick: number): number
  /** index of the measure containing `tick` (clamped to the existing measures) */
  measureAtTick(tick: number): number
}

function upperBound(xs: readonly number[], x: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Strictly increasing boundaries (a beat of at least 10 ms). */
function cleanBoundaries(b: readonly number[]): number[] {
  const out: number[] = [b[0]]
  for (let i = 1; i < b.length; i++) out.push(Math.max(b[i], out[i - 1] + 0.01))
  return out
}

/**
 * Builds the measures from the sheet's bar frames (measure i = bar i). A short first bar is a pickup.
 * The last bar, when it is not a full bar, is padded (a long one is split into a full bar plus a padded
 * one), so the score ends with rests instead of an odd time signature.
 */
export function buildTimeMap(frames: readonly Pick<BarFrame, 'start' | 'end' | 'boundaries' | 'pickup'>[], timeSignature: number): TimeMap {
  const ts = Math.min(12, Math.max(1, Math.round(timeSignature || 4)))
  const measures: Measure[] = []
  let offset = 0
  let number = frames[0]?.pickup ? 0 : 1
  const push = (boundaries: number[], pickup: boolean) => {
    const beats = boundaries.length - 1
    measures.push({
      index: measures.length,
      number: String(pickup ? 0 : number),
      start: boundaries[0],
      end: boundaries[beats],
      boundaries,
      beats,
      offset,
      ticks: beats * DIV,
      pickup,
    })
    offset += beats * DIV
    number = pickup ? 1 : number + 1
  }
  /** pads to a full bar with beats as long as the bar's own */
  const pad = (b: number[]): number[] => {
    const beat = (b[b.length - 1] - b[0]) / (b.length - 1)
    const out = [...b]
    while (out.length - 1 < ts) out.push(out[out.length - 1] + beat)
    return out
  }
  frames.forEach((f, i) => {
    const boundaries = f.boundaries.length >= 2 ? cleanBoundaries(f.boundaries) : [f.start, Math.max(f.end, f.start + 0.5)]
    const beats = boundaries.length - 1
    if (i === frames.length - 1 && i > 0 && beats !== ts) {
      // the song ends inside a bar: full bars with rests at the end rather than an odd time signature
      if (beats < ts) push(pad(boundaries), false)
      else {
        push(boundaries.slice(0, ts + 1), false)
        push(pad(boundaries.slice(ts)), false)
      }
      return
    }
    push(boundaries, i === 0 && f.pickup && beats < ts)
  })
  const starts = measures.map((m) => m.start)
  const offsets = measures.map((m) => m.offset)
  const totalTicks = offset

  const firstBeat = (): [number, number] => {
    const m = measures[0]
    return [m.boundaries[0], m.boundaries[1] - m.boundaries[0]]
  }
  const lastBeat = (): [number, number] => {
    const m = measures[measures.length - 1]
    const b = m.boundaries
    return [b[b.length - 1], b[b.length - 1] - b[b.length - 2]]
  }

  const toTicks = (t: number): number => {
    if (!measures.length || !Number.isFinite(t)) return 0
    if (t < measures[0].start) {
      const [t0, len] = firstBeat()
      return ((t - t0) / len) * DIV
    }
    const mi = upperBound(starts, t) - 1
    const m = measures[mi]
    if (t >= m.end && mi === measures.length - 1) {
      const [t1, len] = lastBeat()
      return totalTicks + ((t - t1) / len) * DIV
    }
    const b = m.boundaries
    const k = Math.min(m.beats - 1, Math.max(0, upperBound(b, t) - 1))
    return m.offset + (k + (t - b[k]) / (b[k + 1] - b[k])) * DIV
  }

  const toSeconds = (tick: number): number => {
    if (!measures.length || !Number.isFinite(tick)) return 0
    if (tick < 0) {
      const [t0, len] = firstBeat()
      return t0 + (tick / DIV) * len
    }
    if (tick >= totalTicks) {
      const [t1, len] = lastBeat()
      return t1 + ((tick - totalTicks) / DIV) * len
    }
    const m = measures[Math.max(0, upperBound(offsets, tick) - 1)]
    const beat = (tick - m.offset) / DIV
    const k = Math.min(m.beats - 1, Math.floor(beat))
    const b = m.boundaries
    return b[k] + (beat - k) * (b[k + 1] - b[k])
  }

  const measureAtTick = (tick: number): number => {
    if (!measures.length) return -1
    return Math.min(measures.length - 1, Math.max(0, upperBound(offsets, tick) - 1))
  }

  return { measures, timeSignature: ts, totalTicks, toTicks, toSeconds, measureAtTick }
}

/**
 * Bar `i` of the chord sheet's `barCount` bars on the measures: measure i — for the last bar also the
 * extra measure of a split long last bar — as one stretch of `beats` beats from tick `offset`, with
 * the barlines inside it (beats from its start).
 */
export function barStretch(measures: readonly Measure[], i: number, barCount: number): { offset: number; beats: number; barlines: number[] } | null {
  const first = measures[i]
  if (!first) return null
  const own = i === barCount - 1 ? measures.slice(i) : [first]
  return {
    offset: first.offset,
    beats: own.reduce((n, m) => n + m.beats, 0),
    barlines: own.slice(1).map((m) => (m.offset - first.offset) / DIV),
  }
}

/** `t` (seconds) on a grid of `step` ticks. */
export function quantize(map: TimeMap, t: number, step: number): number {
  return Math.round(map.toTicks(t) / step) * step
}

/**
 * A note [start, end) (seconds) on the grid: the onset is rounded (with `bias`, an onset between an
 * eighth and an odd sixteenth leans to the eighth — fewer syncopated sixteenths to read); the end is
 * the rounded offset or the onset + the rounded length, whichever keeps both the length and the end
 * closer to what was played (rounding both ends alone can halve a short note). At least one step long.
 * Returns ticks [qs, qe] and the unquantized end in ticks.
 */
export function quantizeSpan(
  map: TimeMap,
  start: number,
  end: number,
  step: number,
  /** extra distance (ticks) an onset may move to land on an eighth instead of an odd sixteenth */
  bias = 0,
): { qs: number; qe: number; rawEnd: number } {
  const s = map.toTicks(start)
  const e = map.toTicks(end)
  let qs = Math.round(s / step) * step
  if (bias > 0 && step < DIV / 2 && qs % (DIV / 2) !== 0) {
    const eighth = Math.round(s / (DIV / 2)) * (DIV / 2)
    if (Math.abs(s - eighth) <= Math.abs(s - qs) + bias) qs = eighth
  }
  const byEnd = Math.round(e / step) * step
  const byLength = qs + Math.round((e - s) / step) * step
  const cost = (qe: number) => Math.abs(qe - qs - (e - s)) + 0.5 * Math.abs(qe - e)
  const qe = Math.max(qs + step, cost(byLength) < cost(byEnd) ? byLength : byEnd)
  return { qs, qe, rawEnd: e }
}
