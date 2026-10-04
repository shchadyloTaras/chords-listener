// Handpan note names: a pitch class plus an optional octave ("A", "Bb3", "C#4").
// Chord matching works on pitch classes, so Bb3 == A#3 and "A" (no octave) matches every A.

import { readNote } from '../music/notes'

export interface HandpanNote {
  /** pitch class 0..11 (C = 0) */
  pc: number
  /** scientific octave (C4 = middle C), or null when it was not given */
  octave: number | null
  /** normalized spelling: uppercase letter + optional "#" / "b" ("Bb", "C#", "A") */
  name: string
}

/** Note spellings offered by the editor (both enharmonics of every black key). */
export const NOTE_NAMES = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'] as const

/** Octaves offered by the editor; handpans live roughly between F2 and F5. */
export const OCTAVES = [2, 3, 4, 5] as const

const LETTER_SEMIS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * Parses one note token: letter A–G (any case), optional accidental (#, ♯, b, ♭) and an
 * optional single-digit octave. "bb3" → Bb3, "c#" → C#, "A" → A (octave unknown).
 */
export function parseHandpanNote(token: string): HandpanNote | null {
  const s = token.trim()
  if (!s) return null
  const n = readNote(s)
  if (!n) return null
  const rest = s.slice(n.length)
  if (rest === '') return { pc: n.pc, octave: null, name: n.name }
  if (!/^[0-8]$/.test(rest)) return null
  return { pc: n.pc, octave: Number(rest), name: n.name }
}

/** "Bb3" / "A" — the stored form of a note. */
export function formatHandpanNote(n: HandpanNote): string {
  return n.octave == null ? n.name : `${n.name}${n.octave}`
}

/** MIDI number (C4 = 60), or null without an octave. Cb4 = B3, B#3 = C4 (spelled letters count). */
export function noteMidi(n: HandpanNote): number | null {
  if (n.octave == null) return null
  const letter = LETTER_SEMIS[n.name.charAt(0)] ?? 0
  const acc = n.name.charAt(1) === '#' ? 1 : n.name.charAt(1) === 'b' ? -1 : 0
  return (n.octave + 1) * 12 + letter + acc
}

/** Enharmonic equality on pitch class (and octave when both notes have one). */
export function sameNote(a: HandpanNote, b: HandpanNote): boolean {
  if (a.pc !== b.pc) return false
  if (a.octave == null || b.octave == null) return true
  return noteMidi(a) === noteMidi(b)
}
