// Capo suggestion: find the capo position (0–7) whose chord shapes are easiest to play.

import { formatChord, parseChord } from './chord'
import type { Spelling } from './notes'

export type CapoInstrument = 'guitar' | 'ukulele'

/** Difficulty of a chord shape: 0 = easy open shape … 3 = full barre (default for unknown shapes). */
const BARRE = 3

const GUITAR: Record<string, number> = {
  C: 0, A: 0, G: 0, E: 0, D: 0, Am: 0, Em: 0, Dm: 0,
  A7: 0, E7: 0, D7: 0, G7: 0.5, C7: 0.5, B7: 1,
  Am7: 0, Em7: 0, Dm7: 0.5, Cmaj7: 0, Fmaj7: 0.5, Amaj7: 0.5, Dmaj7: 0.5, Gmaj7: 1, Emaj7: 1,
  Asus2: 0, Asus4: 0, Dsus2: 0, Dsus4: 0, Esus4: 0, Gsus4: 1, Csus2: 1, Csus4: 1, Esus2: 1,
  Cadd9: 0, Gadd9: 1, Dadd9: 1, Aadd9: 1, Eadd9: 1,
  A6: 0.5, D6: 0.5, G6: 0.5, E6: 1, C6: 1, Em6: 0.5, Am6: 1, Dm6: 1,
  E9: 1, A9: 1, D9: 1.5, C9: 1.5, G9: 1.5,
  Adim: 1.5, Bdim: 1.5, Ddim: 1.5, Edim: 1.5, Adim7: 1.5, Bdim7: 1.5, Ddim7: 1.5, Edim7: 1.5,
  Bm7b5: 1.5, Em7b5: 1.5, Am7b5: 1.5, Dm7b5: 1.5,
  Caug: 1.5, Eaug: 1.5, Aaug: 1.5, Gaug: 1.5,
  F: 2, Bm: 2.5, Bm7: 1.5, Fsus2: 2, F6: 2,
}

const UKULELE: Record<string, number> = {
  C: 0, Am: 0, F: 0, G: 0.5, A: 0.5, Dm: 0.5, Em: 1, D: 1, Gm: 1,
  C7: 0, A7: 0, G7: 0.5, E7: 1, D7: 1, B7: 1.5, Am7: 0, Dm7: 1, Em7: 1, Gm7: 0.5,
  Cmaj7: 0, Fmaj7: 0.5, Gmaj7: 1, Amaj7: 1, Dmaj7: 1,
  Csus2: 0.5, Csus4: 0.5, Gsus2: 0.5, Gsus4: 0.5, Asus4: 0.5, Dsus2: 0.5, Dsus4: 1,
  Cadd9: 0.5, Fadd9: 1, C6: 0, A6: 0.5, Am6: 1,
  Bb: 2, Bm: 2, E: 2.5,
}

/** Slash chords that are only a small step from their open base shape. */
const EASY_SLASH = new Set([
  'C/G', 'C/E', 'C/B', 'G/B', 'G/D', 'G/F#', 'G/F', 'D/F#', 'D/A', 'D/C', 'A/E', 'A/C#', 'A/G',
  'Am/G', 'Am/E', 'Am/C', 'Am/F#', 'Em/D', 'Em/B', 'Em/G', 'E/G#', 'E/D', 'F/C', 'F/A', 'Dm/F', 'Dm/C',
])

export function shapeDifficulty(label: string, instrument: CapoInstrument = 'guitar'): number {
  const p = parseChord(label)
  if (!p) return 0
  const table = instrument === 'ukulele' ? UKULELE : GUITAR
  const base = formatChord({ rootPc: p.rootPc, quality: p.quality }, 'sharp')
  const d = table[base] ?? BARRE
  if (p.bassPc == null) return d
  const slash = formatChord(p, 'sharp')
  return d + (instrument === 'guitar' && EASY_SLASH.has(slash) ? 0.25 : 1)
}

export interface CapoSuggestion {
  capo: number
  /** chord shapes to play with the capo, unique, in order of first appearance */
  shapes: string[]
  /** relative difficulty reduction 0..1 compared with no capo */
  gain: number
}

export interface WeightedChord {
  label: string
  /** how much this chord matters (occurrences or seconds) */
  weight: number
}

/**
 * Suggests a capo position (1..maxCapo) that makes the song noticeably easier, or null when
 * playing without a capo is already as easy. Chords are the labels as displayed (already
 * transposed); `shapes` are what to finger with the capo on.
 */
export function suggestCapo(
  chords: WeightedChord[],
  instrument: CapoInstrument = 'guitar',
  maxCapo = 7,
): CapoSuggestion | null {
  const items = chords.filter((c) => parseChord(c.label) && c.weight > 0)
  if (!items.length) return null
  const total = items.reduce((s, c) => s + c.weight, 0)
  const score = (capo: number) =>
    items.reduce((s, c) => s + c.weight * shapeDifficulty(shapeFor(c.label, capo), instrument), 0) / total +
    capo * 0.04 // tie-break toward lower capo positions
  const base = score(0)
  let best = 0
  let bestScore = base
  for (let capo = 1; capo <= maxCapo; capo++) {
    const s = score(capo)
    if (s < bestScore - 1e-9) {
      best = capo
      bestScore = s
    }
  }
  if (best === 0) return null
  const gain = base > 0 ? (base - bestScore) / base : 0
  // Only worth suggesting when it removes real difficulty (≈ at least one barre chord's worth).
  if (base - bestScore < 0.6 || gain < 0.25) return null
  const shapes: string[] = []
  for (const c of items) {
    const s = shapeFor(c.label, best)
    if (!shapes.includes(s)) shapes.push(s)
  }
  return { capo: best, shapes, gain }
}

/** The shape to finger for `label` with a capo on `capo` (sharps; open shapes are naturals anyway). */
export function shapeFor(label: string, capo: number, spelling: Spelling = 'sharp'): string {
  const p = parseChord(label)
  if (!p) return label
  return formatChord({ rootPc: p.rootPc - capo, quality: p.quality, bassPc: p.bassPc == null ? null : p.bassPc - capo }, spelling)
}
