// Key signature and note spelling for the score. Notes are spelled from the (transposed) key on the
// line of fifths: diatonic notes as in the key, chromatic ones from a window around it (C major:
// C♯ E♭ F♯ G♯ B♭), the raised 7th of a minor key always as the leading tone (A minor: G♯).

import type { KeyInfo } from '../../types'
import { mod12, noteToPc, type Spelling } from '../music/notes'

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'

/** Letters along the line of fifths, starting at F (position −1). */
const FIFTHS_LETTERS: readonly Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
export const STEP_PC: Readonly<Record<Step, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const SHARP_ORDER = 'FCGDAEB'
const FLAT_ORDER = 'BEADGCF'

/** Key signature (fifths) of each major tonic pitch class; 6 = F♯ / G♭ (decided by the spelling). */
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]

export interface KeySig {
  /** −7..7, negative = flats */
  fifths: number
  mode: 'major' | 'minor'
  /** tonic pitch class (after transposition) */
  tonicPc: number
  /** lowest line-of-fifths position used for chromatic notes (12 consecutive positions) */
  lo: number
  /** false when the track has no key (C major is used) */
  known: boolean
}

export interface SpelledPitch {
  step: Step
  /** −2..2 */
  alter: number
  octave: number
}

/** Line-of-fifths position → letter + alteration (F = −1, C = 0, G = 1 … B = 5, F♯ = 6, B♭ = −2). */
export function fromFifths(p: number): { step: Step; alter: number } {
  const i = (((p + 1) % 7) + 7) % 7
  return { step: FIFTHS_LETTERS[i], alter: Math.floor((p + 1) / 7) }
}

/** The position of pitch class `pc` within [lo, lo + 11] on the line of fifths. */
function fifthsPosition(pc: number, lo: number): number {
  // position p sounds pc = 7p mod 12, and 7 · 7 ≡ 1 (mod 12)
  const base = mod12(7 * pc)
  return base + 12 * Math.ceil((lo - base) / 12)
}

/**
 * Key signature for the track's key moved by `transpose` semitones. `prefer` is the displayed
 * accidental spelling: it decides F♯ / G♭ major (D♯ / E♭ minor) and how chromatic notes lean.
 */
export function keySignature(key: Pick<KeyInfo, 'tonic' | 'mode' | 'name'> | null | undefined, transpose: number, prefer: Spelling | 'auto' = 'auto'): KeySig {
  const tonic = key ? (noteToPc(key.tonic) ?? noteToPc(key.name.replace(/m$/, ''))) : null
  if (tonic == null || !key) {
    const lo = prefer === 'flat' ? -6 : prefer === 'sharp' ? -1 : -3
    return { fifths: 0, mode: 'major', tonicPc: 0, lo, known: false }
  }
  const mode = key.mode === 'minor' ? 'minor' : 'major'
  const tonicPc = mod12(tonic + transpose)
  let fifths = MAJOR_FIFTHS[mode === 'minor' ? mod12(tonicPc + 3) : tonicPc]
  if (fifths === 6 && prefer !== 'sharp') fifths = -6
  let lo = mode === 'minor' ? fifths - 2 : fifths - 3
  if (prefer === 'sharp') lo = Math.max(lo, fifths - 1)
  else if (prefer === 'flat') lo = Math.min(lo, fifths - 6)
  return { fifths, mode, tonicPc, lo, known: true }
}

/** Letter + alteration of a pitch class in the key. */
export function spellPc(pc: number, key: KeySig): { step: Step; alter: number } {
  const p = mod12(pc)
  // the leading tone of a minor key is always the raised 7th (A minor: G♯, D minor: C♯)
  if (key.mode === 'minor' && mod12(p - key.tonicPc) === 11) return fromFifths(key.fifths + 8)
  return fromFifths(fifthsPosition(p, key.lo))
}

/** Spelled pitch of a MIDI note (the octave of the written letter: B♯3 sounds as C4). */
export function spellMidi(midi: number, key: KeySig): SpelledPitch {
  const { step, alter } = spellPc(midi, key)
  const octave = Math.round((midi - alter - STEP_PC[step]) / 12) - 1
  return { step, alter, octave }
}

/** Alteration the key signature gives a letter (+1 sharp, −1 flat, 0). */
export function keyAlter(step: Step, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0
  if (fifths < 0) return FLAT_ORDER.indexOf(step) < -fifths ? -1 : 0
  return 0
}

/** MIDI number of a spelled pitch. */
export function midiOf(p: SpelledPitch): number {
  return (p.octave + 1) * 12 + STEP_PC[p.step] + p.alter
}

/** Display name of a key signature's key, e.g. (−3, minor) → "Cm", (2, major) → "D". */
export function keySigName(key: KeySig): string {
  const tonicPos = key.mode === 'minor' ? key.fifths + 3 : key.fifths
  const { step, alter } = fromFifths(tonicPos)
  const acc = alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter)
  return `${step}${acc}${key.mode === 'minor' ? 'm' : ''}`
}
