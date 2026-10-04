// Chord label parsing / formatting / transposition / simplification.
// Label convention (docs/SPEC.md): <root><suffix>[/<bass>] or "N" for no chord.

import type { ChordQuality } from '../../types'
import { mod12, pcToName, readNote, type Spelling } from './notes'

export const QUALITIES: ChordQuality[] = [
  'maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus2', 'sus4', 'dim7', 'hdim7', '6', 'min6', '9', 'add9',
]

/** Canonical suffix written in labels for each quality. */
export const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  dim7: 'dim7',
  hdim7: 'm7b5',
  '6': '6',
  min6: 'm6',
  '9': '9',
  add9: 'add9',
}

/** Semitone intervals above the root. */
export const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10],
  '6': [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 14],
  add9: [0, 4, 7, 14],
}

/** Accepted suffix spellings (exact match first, then case-insensitive for word-like suffixes). */
const SUFFIX_ALIASES: Record<string, ChordQuality> = {
  '': 'maj',
  maj: 'maj',
  M: 'maj',
  major: 'maj',
  m: 'min',
  min: 'min',
  minor: 'min',
  '-': 'min',
  '7': '7',
  dom7: '7',
  maj7: 'maj7',
  M7: 'maj7',
  ma7: 'maj7',
  'Δ': 'maj7',
  'Δ7': 'maj7',
  m7: 'min7',
  min7: 'min7',
  '-7': 'min7',
  dim: 'dim',
  '°': 'dim',
  o: 'dim',
  aug: 'aug',
  '+': 'aug',
  '#5': 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  sus: 'sus4',
  dim7: 'dim7',
  '°7': 'dim7',
  o7: 'dim7',
  m7b5: 'hdim7',
  'm7♭5': 'hdim7',
  min7b5: 'hdim7',
  '-7b5': 'hdim7',
  'ø': 'hdim7',
  'ø7': 'hdim7',
  hdim7: 'hdim7',
  '6': '6',
  M6: '6',
  maj6: '6',
  m6: 'min6',
  min6: 'min6',
  '-6': 'min6',
  '9': '9',
  add9: 'add9',
  add2: 'add9',
}

const NO_CHORD = new Set(['N', 'NC', 'N.C.', 'N.C', 'X', '—', '-', '–'])

export function isNoChordLabel(label: string | null | undefined): boolean {
  if (label == null) return true
  const s = label.trim()
  return s === '' || NO_CHORD.has(s.toUpperCase())
}

export interface ParsedChord {
  /** root as written ("C#", "Eb", "A") */
  root: string
  rootPc: number
  quality: ChordQuality
  /** canonical suffix for the quality ("m7", "maj7", "") */
  suffix: string
  /** slash bass as written, or null */
  bass: string | null
  bassPc: number | null
}

function qualityFromSuffix(rest: string): ChordQuality | null {
  if (rest in SUFFIX_ALIASES) return SUFFIX_ALIASES[rest]
  if (rest.length > 1) {
    const lower = rest.toLowerCase()
    if (lower in SUFFIX_ALIASES) return SUFFIX_ALIASES[lower]
  }
  return null
}

/**
 * Parses a chord label. Returns null for "N" (no chord) and for anything that is not a
 * recognizable chord. Tolerant of common alternative suffix spellings ("Cmin7", "CΔ7", "C-7",
 * "Cø") and lowercase roots ("am"); the root/bass keep the accidental they were written with.
 */
export function parseChord(label: string | null | undefined): ParsedChord | null {
  if (isNoChordLabel(label)) return null
  const s = (label as string).trim().replace(/\s+/g, '')
  const root = readNote(s)
  if (!root) return null
  let rest = s.slice(root.length)
  let bass: string | null = null
  let bassPc: number | null = null
  const slash = rest.lastIndexOf('/')
  if (slash >= 0) {
    const bassStr = rest.slice(slash + 1)
    const b = readNote(bassStr)
    if (!b || b.length !== bassStr.length) return null
    rest = rest.slice(0, slash)
    if (b.pc !== root.pc) {
      bass = b.name
      bassPc = b.pc
    }
  }
  const quality = qualityFromSuffix(rest)
  if (!quality) return null
  return { root: root.name, rootPc: root.pc, quality, suffix: QUALITY_SUFFIX[quality], bass, bassPc }
}

export interface ChordParts {
  rootPc: number
  quality: ChordQuality
  bassPc?: number | null
  /** keep these written names when no spelling is forced */
  root?: string
  bass?: string | null
}

/**
 * Builds a canonical label. With `spelling`, root and bass are re-spelled from their pitch
 * classes; without it, the written names (if given) are kept.
 */
export function formatChord(p: ChordParts, spelling?: Spelling): string {
  const root = spelling || !p.root ? pcToName(p.rootPc, spelling) : p.root
  let label = root + QUALITY_SUFFIX[p.quality]
  if (p.bassPc != null && mod12(p.bassPc) !== mod12(p.rootPc)) {
    const bass = spelling || !p.bass ? pcToName(p.bassPc, spelling) : p.bass
    label += `/${bass}`
  }
  return label
}

/** Canonical form of a label (sharps, canonical suffix). "N" for no-chord; unknown labels pass through. */
export function normalizeChord(label: string, spelling: Spelling = 'sharp'): string {
  if (isNoChordLabel(label)) return 'N'
  const p = parseChord(label)
  return p ? formatChord(p, spelling) : label.trim()
}

/** Transposes a label by `semis` semitones (slash bass included). "N" and unknown labels pass through. */
export function transposeChord(label: string, semis: number, spelling: Spelling = 'sharp'): string {
  const p = parseChord(label)
  if (!p) return label
  return formatChord(
    {
      rootPc: p.rootPc + semis,
      quality: p.quality,
      bassPc: p.bassPc == null ? null : p.bassPc + semis,
    },
    spelling,
  )
}

/**
 * Triad family used by "Simplify":
 *  - 7, maj7, 6, 9, add9 → major;  m7, m6 → minor;  m7b5, dim7 → dim;  aug stays aug.
 *  - sus2 / sus4 → major. Sus chords nearly always resolve to (and can be strummed as) the major
 *    triad on the same root, and dropping them is what makes the simplified view easy to play.
 *  - The slash bass is dropped (G/B → G).
 */
export function simplifyQuality(q: ChordQuality): ChordQuality {
  switch (q) {
    case 'min':
    case 'min7':
    case 'min6':
      return 'min'
    case 'dim':
    case 'dim7':
    case 'hdim7':
      return 'dim'
    case 'aug':
      return 'aug'
    default:
      return 'maj'
  }
}

export function simplifyChord(label: string): string {
  const p = parseChord(label)
  if (!p) return label
  return formatChord({ rootPc: p.rootPc, root: p.root, quality: simplifyQuality(p.quality) })
}

/** Pitch classes of the chord tones (root first, bass prepended when it is not a chord tone). */
export function chordPitchClasses(p: ParsedChord): number[] {
  const pcs = QUALITY_INTERVALS[p.quality].map((i) => mod12(p.rootPc + i))
  if (p.bassPc != null && !pcs.includes(p.bassPc)) pcs.unshift(p.bassPc)
  return pcs
}

export function isMinorQuality(q: ChordQuality | string | null | undefined): boolean {
  return q === 'min' || q === 'min7' || q === 'min6' || q === 'dim' || q === 'dim7' || q === 'hdim7'
}

/** Splits a label into display parts: root, suffix (quality), bass. Unknown labels → whole label as root. */
export function splitLabel(label: string): { root: string; suffix: string; bass: string | null } {
  const p = parseChord(label)
  if (!p) return { root: label, suffix: '', bass: null }
  return { root: p.root, suffix: p.suffix, bass: p.bass }
}

/** All 12 roots × all qualities, for editor autocomplete. */
export function allChordNames(spelling: Spelling = 'sharp'): string[] {
  const out: string[] = []
  for (let pc = 0; pc < 12; pc++) for (const q of QUALITIES) out.push(formatChord({ rootPc: pc, quality: q }, spelling))
  return out
}
