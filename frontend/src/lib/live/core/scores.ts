// Per-frame chord scores, exactly as the offline engine's decodeChords() computes them:
// Bernoulli template fit of the treble chroma + quality priors + bass-chroma root evidence,
// and "N" = best chord - noChordMargin (+30 on silent frames).

import type { AnalyzeParams, Vocabulary } from '../../engine/core/analyze.ts'
import { bernoulliScores, chromaProbabilities } from '../../engine/core/chords.ts'

/**
 * Writes the K = vocab.chords.length + 1 scores of one frame into `out` (float32 like the
 * offline score matrix). `bassLog` is a 12-element scratch array.
 */
export function frameScores(
  treble: Float32Array,
  bass: Float32Array,
  silent: boolean,
  vocab: Vocabulary,
  params: Pick<AnalyzeParams, 'bassWeight' | 'noChordMargin'>,
  out: Float32Array,
  bassLog: Float64Array = new Float64Array(12),
): Float32Array {
  const V = vocab.chords.length
  const K = V + 1
  bernoulliScores(chromaProbabilities(treble, 1), 1, vocab.templates, V, out, K)
  let tot = 0
  for (let i = 0; i < 12; i++) tot += bass[i]
  tot = Math.max(tot, 1e-9)
  for (let i = 0; i < 12; i++) bassLog[i] = params.bassWeight * Math.log(bass[i] / tot + 0.08)
  let best = -Infinity
  for (let k = 0; k < V; k++) {
    const v = out[k] + vocab.priors[k] + bassLog[vocab.chords[k].root!]
    out[k] = v
    if (v > best) best = v
  }
  out[V] = best - params.noChordMargin + (silent ? 30 : 0)
  return out
}
