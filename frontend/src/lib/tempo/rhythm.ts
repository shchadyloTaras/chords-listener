// Per-track tempo correction. Beat trackers often lock onto half or double the real tempo;
// the user can fix that with a factor (×½ / ×1 / ×2) and every bar-based view follows it.

import { tempoFromBeats } from './analysis'

export type TempoFactor = 0.5 | 1 | 2

export const TEMPO_FACTORS: readonly TempoFactor[] = [0.5, 1, 2]

/** Any stored value → a valid factor (unknown / missing → 1). */
export function normalizeFactor(x: unknown): TempoFactor {
  return x === 0.5 || x === 2 ? x : 1
}

export interface RhythmInput {
  beats?: readonly number[] | null
  downbeats?: readonly number[] | null
  tempo?: number | null
  timeSignature?: number | null
  /** song length; lets ×2 add the off-beat after the last beat */
  duration?: number | null
}

export interface EffectiveRhythm {
  factor: TempoFactor
  /** beat times after the correction */
  beats: number[]
  /** downbeat times after the correction */
  downbeats: number[]
  /** global tempo after the correction (BPM), null when unknown */
  tempo: number | null
  /** global tempo as detected (BPM), null when unknown */
  detectedTempo: number | null
  /** beats per bar, 2..12 */
  timeSignature: number
}

const plausible = (bpm: number | null | undefined): bpm is number => bpm != null && bpm > 20 && bpm < 400

function sortedFinite(xs: readonly number[] | null | undefined): number[] {
  return (xs ?? []).filter(Number.isFinite).sort((a, b) => a - b)
}

/** Index of the beat nearest to `t` when within `tol`, else -1. */
function nearestIndex(beats: number[], t: number, tol: number): number {
  let best = -1
  let bestD = tol
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i] - t)
    if (d <= bestD) {
      bestD = d
      best = i
    }
    if (beats[i] > t + tol) break
  }
  return best
}

/** Inserts the midpoint between every pair of neighbours (and after the last one, when it fits). */
function withMidpoints(xs: number[], duration: number | null | undefined): number[] {
  const out: number[] = []
  for (let i = 0; i < xs.length; i++) {
    out.push(xs[i])
    if (i + 1 < xs.length) out.push((xs[i] + xs[i + 1]) / 2)
  }
  if (xs.length >= 2 && duration && duration > 0) {
    const last = xs[xs.length - 1]
    const half = (last - xs[xs.length - 2]) / 2
    if (last + half < duration - 0.05) out.push(last + half)
  }
  return out
}

/** Every `ts`-th beat starting at index k0 (the first downbeat is kept as the first downbeat). */
function everyNth(beats: number[], k0: number, ts: number): number[] {
  const out: number[] = []
  for (let i = k0; i < beats.length; i += ts) out.push(beats[i])
  return out
}

/**
 * Beats / downbeats / tempo after the correction factor:
 * - ×2 inserts the midpoints between beats and recomputes downbeats every `timeSignature` beats,
 *   keeping the first detected downbeat;
 * - ×½ keeps every other beat (the parity that contains the first downbeat), downbeats likewise;
 * - ×1 returns the detection unchanged (same array references).
 */
export function effectiveRhythm(input: RhythmInput, factor: TempoFactor): EffectiveRhythm {
  const ts = Math.min(12, Math.max(2, Math.round(input.timeSignature || 4)))
  const srcBeats = (input.beats ?? []) as number[]
  const srcDowns = (input.downbeats ?? []) as number[]
  const detectedTempo = plausible(input.tempo) ? input.tempo : tempoFromBeats(srcBeats)

  if (factor === 1) {
    return { factor, beats: srcBeats, downbeats: srcDowns, tempo: detectedTempo, detectedTempo, timeSignature: ts }
  }

  const beats = sortedFinite(srcBeats)
  const downs = sortedFinite(srcDowns)
  let outBeats: number[]
  let outDowns: number[]

  if (beats.length >= 2) {
    const ibi = (beats[beats.length - 1] - beats[0]) / (beats.length - 1)
    const tol = Math.max(0.05, ibi * 0.3)
    if (factor === 2) {
      outBeats = withMidpoints(beats, input.duration)
      const k0 = downs.length ? nearestIndex(outBeats, downs[0], tol) : -1
      outDowns = k0 >= 0 ? everyNth(outBeats, k0, ts) : []
    } else {
      const k = downs.length ? nearestIndex(beats, downs[0], tol) : -1
      const parity = k >= 0 ? k % 2 : 0
      outBeats = beats.filter((_, i) => i % 2 === parity)
      const k0 = k >= 0 ? (k - parity) / 2 : -1
      outDowns = k0 >= 0 ? everyNth(outBeats, k0, ts) : []
    }
  } else {
    // No usable beats: correct the bar grid through the downbeats alone.
    outBeats = beats
    outDowns = factor === 2 ? withMidpoints(downs, input.duration) : downs.filter((_, i) => i % 2 === 0)
  }

  const scaled = plausible(input.tempo) ? input.tempo * factor : null
  const tempo = scaled ?? tempoFromBeats(outBeats) ?? (detectedTempo != null ? detectedTempo * factor : null)
  return { factor, beats: outBeats, downbeats: outDowns, tempo, detectedTempo, timeSignature: ts }
}

/** Display tempo for a stored track tempo and its correction factor (null when unknown). */
export function correctedTempo(tempo: number | null | undefined, factor: unknown): number | null {
  return plausible(tempo) ? tempo * normalizeFactor(factor) : null
}
