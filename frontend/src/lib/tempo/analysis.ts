// Beat-grid maths: searching beats by time, global / local tempo and a tempo curve.
// All times are seconds, tempos are beats per minute. Pure functions, no React.

/** Inter-beat intervals outside this range are tracker glitches, not tempo (same as the engine). */
export const MIN_IBI = 0.2
export const MAX_IBI = 2

/** First index i with xs[i] >= x (xs sorted ascending); xs.length when none. */
export function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index of the last beat at or before t, or -1 before the first beat. */
export function beatIndexAt(beats: readonly number[], t: number): number {
  let lo = 0
  let hi = beats.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

export interface BeatPosition {
  /** last beat at or before t (-1 before the first beat) */
  index: number
  /** 0..1 progress from that beat to the next one (0 before the first beat) */
  phase: number
}

/** Beat index and phase at time t. After the last beat the previous interval is extrapolated. */
export function beatAt(beats: readonly number[], t: number): BeatPosition {
  const index = beatIndexAt(beats, t)
  if (index < 0) return { index, phase: 0 }
  const a = beats[index]
  const b = index + 1 < beats.length ? beats[index + 1] : index > 0 ? a + (a - beats[index - 1]) : NaN
  if (!(b > a)) return { index, phase: 0 }
  return { index, phase: Math.min(1, Math.max(0, (t - a) / (b - a))) }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Median plausible inter-beat interval, or null with fewer than 2 beats. */
export function medianInterval(beats: readonly number[]): number | null {
  const ibis: number[] = []
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1]
    if (d >= MIN_IBI && d <= MAX_IBI) ibis.push(d)
  }
  return ibis.length ? median(ibis) : null
}

/** Global tempo from beat times (60 / median interval), or null. */
export function tempoFromBeats(beats: readonly number[]): number | null {
  const m = medianInterval(beats)
  return m ? 60 / m : null
}

export interface LocalTempoOptions {
  /** inter-beat intervals taken on each side of t (default 4 → a window of ~8 beats) */
  radius?: number
  /** intervals deviating from the window median by more than this share are ignored */
  outlier?: number
}

/**
 * Tempo around time t: a triangular-weighted mean of the inter-beat intervals in a small window
 * centred on t, after dropping glitches (implausible or far-from-median intervals).
 */
export function localTempo(beats: readonly number[], t: number, opts: LocalTempoOptions = {}): number | null {
  const n = beats.length
  if (n < 3) return null
  const radius = Math.max(1, opts.radius ?? 4)
  const outlier = opts.outlier ?? 0.3
  // Interval k spans beats[k]..beats[k+1]; centre the window on the interval containing t.
  const k0 = Math.min(n - 2, Math.max(0, beatIndexAt(beats, t)))
  const from = Math.max(0, k0 - radius)
  const to = Math.min(n - 2, k0 + radius)
  const ibis: { d: number; mid: number }[] = []
  for (let k = from; k <= to; k++) {
    const d = beats[k + 1] - beats[k]
    if (d >= MIN_IBI && d <= MAX_IBI) ibis.push({ d, mid: (beats[k] + beats[k + 1]) / 2 })
  }
  if (ibis.length < 2) return null
  const m = median(ibis.map((x) => x.d))
  const kept = ibis.filter((x) => Math.abs(x.d - m) <= m * outlier)
  if (kept.length < 2) return 60 / m
  const span = Math.max(m * (radius + 1), ...kept.map((x) => Math.abs(x.mid - t) + m))
  let wSum = 0
  let dSum = 0
  for (const x of kept) {
    const w = Math.max(0.05, 1 - Math.abs(x.mid - t) / span)
    wSum += w
    dSum += w * x.d
  }
  return 60 / (dSum / wSum)
}

export interface TempoPoint {
  t: number
  bpm: number
}

/** Local tempo sampled at `points` evenly spaced times over start..duration (for a sparkline). */
export function tempoCurve(beats: readonly number[], duration: number, points = 64, start = 0): TempoPoint[] {
  if (beats.length < 3 || !(duration > start)) return []
  const n = Math.max(2, Math.round(points))
  const first = beats[0]
  const last = beats[beats.length - 1]
  const out: TempoPoint[] = []
  for (let i = 0; i < n; i++) {
    const t = start + ((duration - start) * i) / (n - 1)
    const bpm = localTempo(beats, Math.min(last, Math.max(first, t)))
    if (bpm != null) out.push({ t, bpm })
  }
  return out
}
