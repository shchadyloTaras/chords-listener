// One hand's chord shape, the way keyboard players take chords: the tones in close position (all
// within an octave) and, of the inversions, the one that sits nearest where the hand rests, so it
// barely moves from chord to chord (C = C E G, F = C F A, G = B D G around E4). Shared by the piano's
// right hand and the harmonium's one hand.

import { mod12 } from '../music/notes'

export interface ShapeOptions {
  /** pitch class of the chord's root: an inversion tie goes to root position */
  rootPc: number
  /** every note within [low, high] (same pitch numbering as `centre`) */
  low: number
  high: number
  /** where the hand rests: the shape whose notes average nearest it */
  centre: number
  /** pitch class that must be the lowest note (a slash bass played by this hand) */
  lowest?: number | null
}

/** The shape's notes, ascending; [] for no pitch classes or no placement inside the range. */
export function closeShape(pcs: readonly number[], opts: ShapeOptions): number[] {
  const set = [...new Set(pcs.map(mod12))]
  if (!set.length) return []
  let best: { notes: number[]; dist: number; rooted: boolean } | null = null
  for (const lowPc of opts.lowest != null ? [mod12(opts.lowest)] : set) {
    const up = set.map((pc) => mod12(pc - lowPc)).sort((a, b) => a - b)
    const first = opts.low + mod12(lowPc - opts.low)
    for (let low = first; low + up[up.length - 1] <= opts.high; low += 12) {
      const notes = up.map((d) => low + d)
      const dist = Math.abs(notes.reduce((a, b) => a + b, 0) / notes.length - opts.centre)
      const rooted = lowPc === mod12(opts.rootPc)
      if (!best || dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) < 1e-9 && rooted && !best.rooted)) best = { notes, dist, rooted }
    }
  }
  return best ? best.notes : []
}
