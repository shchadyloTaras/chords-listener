// The concert flute (Boehm system, in C, closed G♯ key, C foot): its fingering chart.
//
// Keys, from the head joint down, as beginner fingering charts draw them: the left thumb's B key and
// the B♭ (Briccialdi) lever beside it, the left index / middle / ring fingers, the left little
// finger's G♯ key; the right index / middle / ring fingers; the right little finger's D♯ (E♭) key
// and the foot joint's C♯ and C rollers (the trill keys only matter from B♭6 up, left out). Fingerings:
// the standard first choice of every note C4–A6, the same in the Woodwind Fingering Guide's basic
// charts (wfg.woodwind.org/flute) and flutetunes.com's — B♭ with the thumb on the B♭ lever. Registers:
// low C4–C♯5, middle D5–C♯6 (E5–C♯6 overblown with the low fingerings), high D6 up.

import type { WindKey, WindSpec } from './types'

const hole = (id: string, label: string, y: number): WindKey => ({ id, label, x: 5, y, rx: 2.3, ry: 2.3, kind: 'hole' })

const KEYS: readonly WindKey[] = [
  { id: 'Bb', label: 'B♭ (thumb)', x: 1.25, y: 12.2, rx: 0.85, ry: 1.3, kind: 'key' },
  { id: 'T', label: 'B (thumb)', x: 1.25, y: 8.6, rx: 0.95, ry: 1.6, kind: 'key' },
  hole('L1', 'L1', 6.6),
  hole('L2', 'L2', 12),
  hole('L3', 'L3', 17.4),
  { id: 'G#', label: 'G♯', x: 8.75, y: 20.6, rx: 0.95, ry: 1.4, kind: 'key' },
  hole('R1', 'R1', 26.2),
  hole('R2', 'R2', 31.6),
  hole('R3', 'R3', 37),
  { id: 'Eb', label: 'E♭', x: 8.75, y: 40.2, rx: 0.95, ry: 1.4, kind: 'key' },
  { id: 'C#', label: 'C♯', x: 5, y: 42.7, rx: 1.9, ry: 0.85, kind: 'key' },
  { id: 'C', label: 'C', x: 5, y: 45, rx: 1.9, ry: 0.85, kind: 'key' },
]

//                Bb T  L1 L2 L3 G#  R1 R2 R3  Eb C# C
const F: Record<number, string> = {
  60: /* C4  */ 'o x  x x x  o   x x x   o  o x',
  61: /* C#4 */ 'o x  x x x  o   x x x   o  x o',
  62: /* D4  */ 'o x  x x x  o   x x x   o  o o',
  63: /* Eb4 */ 'o x  x x x  o   x x x   x  o o',
  64: /* E4  */ 'o x  x x x  o   x x o   x  o o',
  65: /* F4  */ 'o x  x x x  o   x o o   x  o o',
  66: /* F#4 */ 'o x  x x x  o   o o x   x  o o',
  67: /* G4  */ 'o x  x x x  o   o o o   x  o o',
  68: /* G#4 */ 'o x  x x x  x   o o o   x  o o',
  69: /* A4  */ 'o x  x x o  o   o o o   x  o o',
  70: /* Bb4 */ 'x o  x o o  o   o o o   x  o o',
  71: /* B4  */ 'o x  x o o  o   o o o   x  o o',
  72: /* C5  */ 'o o  x o o  o   o o o   x  o o',
  73: /* C#5 */ 'o o  o o o  o   o o o   x  o o',
  74: /* D5  */ 'o x  o x x  o   x x x   o  o o',
  75: /* Eb5 */ 'o x  o x x  o   x x x   x  o o',
  76: /* E5  */ 'o x  x x x  o   x x o   x  o o',
  77: /* F5  */ 'o x  x x x  o   x o o   x  o o',
  78: /* F#5 */ 'o x  x x x  o   o o x   x  o o',
  79: /* G5  */ 'o x  x x x  o   o o o   x  o o',
  80: /* G#5 */ 'o x  x x x  x   o o o   x  o o',
  81: /* A5  */ 'o x  x x o  o   o o o   x  o o',
  82: /* Bb5 */ 'x o  x o o  o   o o o   x  o o',
  83: /* B5  */ 'o x  x o o  o   o o o   x  o o',
  84: /* C6  */ 'o o  x o o  o   o o o   x  o o',
  85: /* C#6 */ 'o o  o o o  o   o o o   x  o o',
  86: /* D6  */ 'o x  o x x  o   o o o   x  o o',
  87: /* Eb6 */ 'o x  x x x  x   x x x   x  o o',
  88: /* E6  */ 'o x  x x o  o   x x o   x  o o',
  89: /* F6  */ 'o x  x o x  o   x o o   x  o o',
  90: /* F#6 */ 'o x  x o x  o   o o x   x  o o',
  91: /* G6  */ 'o o  x x x  o   o o o   x  o o',
  92: /* G#6 */ 'o o  o x x  x   o o o   x  o o',
  93: /* A6  */ 'o x  o x o  o   x o o   x  o o',
}

export const FLUTE: WindSpec = {
  instrument: 'flute',
  keys: KEYS,
  width: 10,
  height: 46.4,
  handBreak: 22.4,
  head: 'embouchure',
  // the first register runs to C♯5; D5–C♯6 overblown to the octave, D6 up to the higher harmonics
  registers: [74, 86],
  fingerings: F,
  // the arpeggio's first note D4–C♯5, so it stays in D4–D♯6: the low and middle registers, where
  // players accompany (the low one is weak, A6 up shrill)
  startLow: 62,
}
