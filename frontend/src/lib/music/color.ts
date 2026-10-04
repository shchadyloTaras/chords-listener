// Chord colors: hue by the root's position on the circle of fifths (see index.css --chord-N).

import { isMinorQuality } from './chord'
import { mod12, noteToPc } from './notes'

/** C=0, G=1, D=2, A=3, E=4, B=5, F#=6, C#=7, G#=8, D#=9, A#=10, F=11 */
export function fifthsIndex(pc: number): number {
  return mod12(pc * 7)
}

/** CSS color for a chord root (note name or pitch class). No root → neutral "no chord" color. */
export function chordColor(root: string | number | null | undefined): string {
  const pc = typeof root === 'number' ? root : noteToPc(root ?? null)
  return pc == null ? 'var(--chord-none)' : `var(--chord-${fifthsIndex(pc)})`
}

/**
 * Chord color with the minor treatment: same hue, slightly darker / desaturated, so
 * relative major/minor pairs stay visibly related.
 */
export function chordTone(root: string | number | null | undefined, quality?: string | null): string {
  const base = chordColor(root)
  if (base === 'var(--chord-none)' || !isMinorQuality(quality)) return base
  return `color-mix(in oklch, ${base} 78%, var(--muted))`
}
