// Pitch-class helpers. Pitch class (pc) = 0..11, C = 0.

export type Spelling = 'sharp' | 'flat'

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export function mod12(n: number): number {
  return ((Math.round(n) % 12) + 12) % 12
}

export interface ReadNote {
  pc: number
  /** normalized spelling as written: uppercase letter + optional "#" / "b" */
  name: string
  /** characters consumed from the input */
  length: number
}

/**
 * Reads a note name at the start of `s`: a letter A–G (case-insensitive) followed by an
 * optional single accidental (`#`, `♯`, `b`, `♭`).
 */
export function readNote(s: string): ReadNote | null {
  const letter = s.charAt(0).toUpperCase()
  if (!(letter in LETTER_PC)) return null
  let pc = LETTER_PC[letter]
  const acc = s.charAt(1)
  if (acc === '#' || acc === '♯') return { pc: mod12(pc + 1), name: `${letter}#`, length: 2 }
  if (acc === 'b' || acc === '♭') {
    pc -= 1
    return { pc: mod12(pc), name: `${letter}b`, length: 2 }
  }
  return { pc, name: letter, length: 1 }
}

/** Pitch class of a complete note name ("C#", "Eb", "B"), or null. */
export function noteToPc(name: string | null | undefined): number | null {
  if (!name) return null
  const n = readNote(name.trim())
  return n && n.length === name.trim().length ? n.pc : null
}

export function pcToName(pc: number, spelling: Spelling = 'sharp'): string {
  return (spelling === 'flat' ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)]
}
