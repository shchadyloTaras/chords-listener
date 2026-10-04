// Global key: chord-histogram fit (diatonic chord weights) + pitch-class profile correlation.

import type { KeyInfo } from '../../../types'
import { PITCH_NAMES, type Chord } from './chords.ts'

// Temperley (Kostka-Payne) profiles
const MAJOR_PROFILE = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0]
const MINOR_PROFILE = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]

type Coarse = 'maj' | 'min' | 'dim' | 'sus'

// diatonic triads: "interval from tonic:coarse quality" -> weight
const MAJOR_CHORDS: Record<string, number> = {
  '0:maj': 1.0, '2:min': 0.8, '4:min': 0.7, '5:maj': 1.0, '7:maj': 1.0, '9:min': 0.9, '11:dim': 0.5,
  '10:maj': 0.35, '2:maj': 0.3, '4:maj': 0.3, '5:min': 0.3,
}
const MINOR_CHORDS: Record<string, number> = {
  '0:min': 1.0, '2:dim': 0.5, '3:maj': 0.9, '5:min': 0.9, '7:min': 0.6, '7:maj': 0.9, '8:maj': 0.9,
  '10:maj': 0.9, '5:maj': 0.3, '2:min': 0.3,
}

const COARSE: Record<string, Coarse> = {
  maj: 'maj', '7': 'maj', maj7: 'maj', '6': 'maj', '9': 'maj', add9: 'maj', aug: 'maj',
  min: 'min', min7: 'min', min6: 'min', dim: 'dim', dim7: 'dim', hdim7: 'dim', sus2: 'sus', sus4: 'sus',
}

function profileScores(chroma: ArrayLike<number>): Float64Array {
  const scores = new Float64Array(24)
  let m = 0
  for (let i = 0; i < 12; i++) m += chroma[i] / 12
  const c = Array.from({ length: 12 }, (_, i) => chroma[i] - m)
  const cn = Math.hypot(...c)
  if (cn < 1e-9) return scores
  ;[MAJOR_PROFILE, MINOR_PROFILE].forEach((prof, mode) => {
    const pm = prof.reduce((s, v) => s + v, 0) / 12
    for (let k = 0; k < 12; k++) {
      let dot = 0
      let pn = 0
      for (let i = 0; i < 12; i++) {
        const p = prof[(i - k + 12) % 12] - pm
        dot += c[i] * p
        pn += p * p
      }
      scores[mode * 12 + k] = dot / (cn * Math.sqrt(pn))
    }
  })
  return scores
}

function chordScores(chords: readonly [Chord, number][], tonicWeight = 0.6, firstBonus = 0.3, lastBonus = 0.2): Float64Array {
  const scores = new Float64Array(24)
  const voiced = chords.filter(([c, d]) => c.root !== null && d > 0)
  const total = voiced.reduce((s, [, d]) => s + d, 0)
  if (total <= 0) return scores
  const first = voiced[0][0]
  const last = voiced[voiced.length - 1][0]
  ;[MAJOR_CHORDS, MINOR_CHORDS].forEach((table, mode) => {
    const tonicQ: Coarse = mode === 0 ? 'maj' : 'min'
    for (let k = 0; k < 12; k++) {
      let fit = 0
      let tonicShare = 0
      for (const [c, d] of voiced) {
        const coarse = COARSE[c.quality ?? 'maj'] ?? 'maj'
        const rel = (c.root! - k + 12) % 12
        const w = coarse === 'sus'
          ? Math.max(table[`${rel}:maj`] ?? 0, table[`${rel}:min`] ?? 0) * 0.8
          : table[`${rel}:${coarse}`] ?? 0
        fit += w * d
        if (rel === 0 && coarse === tonicQ) tonicShare += d
      }
      let s = fit / total + (tonicWeight * tonicShare) / total
      for (const [c, bonus] of [[first, firstBonus], [last, lastBonus]] as const) {
        if ((c.root! - k + 12) % 12 === 0 && COARSE[c.quality ?? ''] === tonicQ) s += bonus
      }
      scores[mode * 12 + k] = s
    }
  })
  return scores
}

/** Scores of the 24 keys (0..11 major from C, 12..23 minor from C). */
export function keyScores(chords: readonly [Chord, number][], chromaMean: ArrayLike<number> | null,
  wChords = 2.5, wProfile = 1.0): Float64Array {
  const s = chordScores(chords)
  for (let i = 0; i < 24; i++) s[i] *= wChords
  if (chromaMean) {
    const p = profileScores(chromaMean)
    for (let i = 0; i < 24; i++) s[i] += wProfile * p[i]
  }
  return s
}

export function detectKey(chords: readonly [Chord, number][], chromaMean: ArrayLike<number> | null): KeyInfo {
  const s = keyScores(chords, chromaMean)
  if (s.every((v) => v === 0)) return { tonic: 'C', mode: 'major', name: 'C', confidence: 0 }
  let best = 0
  for (let i = 1; i < 24; i++) if (s[i] > s[best]) best = i
  let z = 0
  for (let i = 0; i < 24; i++) z += Math.exp((s[i] - s[best]) * 4)
  const tonic = PITCH_NAMES[best % 12]
  const mode = best < 12 ? 'major' : 'minor'
  return {
    tonic,
    mode,
    name: tonic + (mode === 'major' ? '' : 'm'),
    confidence: Math.round((1 / z) * 1000) / 1000,
  }
}
