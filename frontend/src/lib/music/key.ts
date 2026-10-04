// Key handling: accidental spelling by key, key transposition / display.

import type { Accidentals } from '../../store'
import type { KeyInfo } from '../../types'
import { mod12, noteToPc, pcToName, type Spelling } from './notes'

export type Mode = 'major' | 'minor'

/** Major keys written with flats: F Bb Eb Ab Db Gb. */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6])
/** Minor keys written with flats: Dm Gm Cm Fm Bbm Ebm. */
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3])

export function keyPrefersFlats(tonicPc: number, mode: Mode): boolean {
  return (mode === 'minor' ? FLAT_MINOR : FLAT_MAJOR).has(mod12(tonicPc))
}

function keyTonicPc(key: KeyInfo | null | undefined): number | null {
  if (!key) return null
  return noteToPc(key.tonic) ?? noteToPc(key.name.replace(/m$/, ''))
}

/**
 * Spelling used for display. "auto" follows the (transposed) key; with an unknown key it
 * falls back to sharps.
 */
export function resolveSpelling(accidentals: Accidentals, key: KeyInfo | null | undefined, transpose = 0): Spelling {
  if (accidentals === 'sharp') return 'sharp'
  if (accidentals === 'flat') return 'flat'
  const pc = keyTonicPc(key)
  if (pc == null || !key) return 'sharp'
  return keyPrefersFlats(pc + transpose, key.mode) ? 'flat' : 'sharp'
}

export function formatKeyName(tonicPc: number, mode: Mode, spelling: Spelling): string {
  return pcToName(tonicPc, spelling) + (mode === 'minor' ? 'm' : '')
}

/** Display name of the key after transposition, e.g. ("Am", +2, sharp) → "Bm". */
export function transposeKeyName(key: KeyInfo | null | undefined, semis: number, spelling: Spelling): string | null {
  const pc = keyTonicPc(key)
  if (pc == null || !key) return null
  return formatKeyName(pc + semis, key.mode, spelling)
}

/** Signed transpose amount for display: "+2", "−3", "0". */
export function formatTranspose(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return `−${Math.abs(n)}`
  return '0'
}
