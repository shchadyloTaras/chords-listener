// The sopilka: the chromatic soprano ("prima") in C — the ten-hole system of Dmytro Demenchuk, the
// one Ukrainian music schools teach (the Melnytsia-Podilska factory model, 32 cm). Sounding C5–B6;
// written an octave lower, like a soprano recorder.
//
// Holes, left hand on top: the left thumb's hole, then the left index, middle, ring and little
// fingers; the right thumb's hole, then the right index, middle, ring and little fingers — every
// finger has its own hole, the thumbs' are on the back, the little fingers' set off to the side.
// No half-holing: every chromatic note has a fork fingering. The second octave takes the first
// octave's fingerings, blown about twice as hard; only G♯6 differs (the right hand lifted).
// Fingerings: M. Kulbovskyy, «Голосом сопілки» (music-school textbook, 2017), p. 15 — the same as the
// Kyiv chart «Аплікатура сопілки прима» (recorderhomepage.net/sopilka).

import type { WindKey, WindSpec } from './types'

const front = (id: string, label: string, y: number, little = false): WindKey =>
  little ? { id, label, x: 6.6, y, rx: 1.55, ry: 1.55, kind: 'hole' } : { id, label, x: 5, y, rx: 2.05, ry: 2.05, kind: 'hole' }
const thumb = (id: string, label: string, y: number): WindKey => ({ id, label, x: 1.35, y, rx: 1.25, ry: 1.6, kind: 'hole', back: true })

const KEYS: readonly WindKey[] = [
  thumb('LT', 'L thumb', 9.6),
  front('L1', 'L1', 8),
  front('L2', 'L2', 12.8),
  front('L3', 'L3', 17.6),
  front('L4', 'L4', 21.8, true),
  thumb('RT', 'R thumb', 28.4),
  front('R1', 'R1', 27.2),
  front('R2', 'R2', 32),
  front('R3', 'R3', 36.8),
  front('R4', 'R4', 41, true),
]

//                  LT L1 L2 L3 L4  RT R1 R2 R3 R4
const FIRST: Record<number, string> = {
  72: /* C5  */ 'x  x x x x   x  x x x x',
  73: /* C#5 */ 'x  x x x x   x  x x x o',
  74: /* D5  */ 'x  x x x x   x  x x o o',
  75: /* Eb5 */ 'x  x x x x   o  x x o o',
  76: /* E5  */ 'x  x x x x   x  x o o o',
  77: /* F5  */ 'x  x x x x   x  o o o o',
  78: /* F#5 */ 'x  x x x o   x  o o o o',
  79: /* G5  */ 'x  x x o o   x  o o o o',
  80: /* G#5 */ 'x  x o x x   x  x x x x',
  81: /* A5  */ 'x  x o o o   x  o o o o',
  82: /* Bb5 */ 'o  x o o o   x  x x x x',
  83: /* B5  */ 'x  o o o o   x  x x x x',
}

const F: Record<number, string> = { ...FIRST }
for (const [m, f] of Object.entries(FIRST)) F[Number(m) + 12] = f
F[92] = /* G#6 */ 'x  x o x x   o  o o o o'

export const SOPILKA: WindSpec = {
  instrument: 'sopilka',
  keys: KEYS,
  width: 10,
  height: 44,
  handBreak: 24.6,
  head: 'window',
  registers: [84],
  fingerings: F,
  // the arpeggio's first note C5–B5: the lower octave, the second one for the notes above it
  startLow: 72,
}
