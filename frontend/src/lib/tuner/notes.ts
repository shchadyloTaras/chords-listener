// Notes for the tuner: a frequency against the equal-tempered note nearest to it, for a movable A4.

import { pcToName, type Spelling } from '../music/notes'
import type { Accidentals, Lang } from '../../store'

export const A4_DEFAULT = 440
export const A4_MIN = 400
export const A4_MAX = 480
/** within this many cents of the note the tuner shows «in tune» */
export const IN_TUNE_CENTS = 5

/** A4 within A4_MIN..A4_MAX in whole hertz; anything unreadable is the default. */
export function clampA4(hz: number): number {
  if (!Number.isFinite(hz)) return A4_DEFAULT
  return Math.min(A4_MAX, Math.max(A4_MIN, Math.round(hz)))
}

export interface NearestNote {
  midi: number
  /** deviation from that note, -50..+50 in 0.1 steps (exactly half way belongs to the note above) */
  cents: number
}

export function hzToNote(hz: number, a4: number): NearestNote {
  const exact = 69 + 12 * Math.log2(hz / a4)
  const midi = Math.round(exact)
  // + 0: no "-0"
  return { midi, cents: Math.round((exact - midi) * 1000) / 10 + 0 }
}

export function noteHz(midi: number, a4: number): number {
  return a4 * 2 ** ((midi - 69) / 12)
}

/** "C#" / "Db" and the scientific octave (middle C = C4). */
export function noteName(midi: number, spelling: Spelling): { name: string; octave: number } {
  return { name: pcToName(midi, spelling), octave: Math.floor(midi / 12) - 1 }
}

/** The tuner spells with flats only when the user chose flats; "auto" has no key to follow here. */
export function tunerSpelling(accidentals: Accidentals): Spelling {
  return accidentals === 'flat' ? 'flat' : 'sharp'
}

export function isInTune(cents: number): boolean {
  return Math.abs(cents) <= IN_TUNE_CENTS
}

/** "82,4" / "82.4": one decimal, the language's decimal mark, no grouping. */
export function formatHz(hz: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'uk' ? 'uk-UA' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(hz)
}

/** "+7", "−12" (a true minus sign), "0": whole cents. */
export function formatCents(cents: number): string {
  const r = Math.round(cents)
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0'
}
