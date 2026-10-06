// Keyboard geometry for the live piano: which keys to show (fitted to the song on the piano, the
// instrument's own 37 keys on the harmonium), where every key and falling-note lane is, and how
// notes outside the shown range fold onto it. A range may start and end on any key (A0…C8, C3…C6).
//
// Key proportions follow a real piano: an octave is 7 equal white keys, and at the back of the
// keyboard all 12 keys share the octave equally (7/12 of a white key each), which places the black
// keys off-centre like on the instrument (C♯/D♯ pushed apart, F♯ G♯ A♯ spread). Black keys are
// 0.58 of a white key wide and 0.63 as long.

import { HARMONIUM_HIGH, HARMONIUM_LOW } from '../../../lib/diagrams/harmonium'

export const PIANO_LOW = 21 // A0
export const PIANO_HIGH = 108 // C8
const BLACK = new Set([1, 3, 6, 8, 10])
/** white-key index within the octave (black keys: the white key on their left) */
const WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

export const BLACK_WIDTH = 0.58
export const BLACK_LENGTH = 0.63

export function isBlack(midi: number): boolean {
  return BLACK.has(((midi % 12) + 12) % 12)
}

export interface KeyRange {
  /** lowest / highest MIDI note shown (inclusive) */
  low: number
  high: number
}

/** Whole octaves C…B (A0…C8 at the instrument's ends) covering low..high, clamped to the piano. */
export function octaveRange(low: number, high: number): KeyRange {
  const lo = Math.floor(Math.max(PIANO_LOW, Math.min(low, high)) / 12) * 12
  const hi = Math.floor(Math.min(PIANO_HIGH, Math.max(low, high)) / 12) * 12 + 11
  return { low: Math.max(PIANO_LOW, lo), high: Math.min(PIANO_HIGH, hi) }
}

export function octaveCount(r: KeyRange): number {
  return (Math.floor(r.high / 12) - Math.floor(r.low / 12)) + 1
}

/** Number of white keys in a range. */
export function whiteCount(r: KeyRange): number {
  let n = 0
  for (let m = r.low; m <= r.high; m++) if (!isBlack(m)) n++
  return n
}

export interface FitOptions {
  /** at least this many octaves (unless the whole piano is shown) */
  minOctaves: number
  /** at most this many (density-centred window); Infinity = as many as the notes need */
  maxOctaves: number
  /** share of the note weight that may be left outside as outliers (folded onto the range) */
  outliers?: number
}

export const DEFAULT_RANGE: KeyRange = { low: 36, high: 83 } // C2…B5

function quantileIndex(weights: ArrayLike<number>, total: number, q: number): number {
  let acc = 0
  for (let m = 0; m < weights.length; m++) {
    acc += weights[m]
    if (acc >= q * total && weights[m] > 0) return m
  }
  return weights.length - 1
}

/**
 * Keyboard range for a song from its duration-weighted pitch histogram (index = MIDI number):
 * whole octaves around the notes (ignoring the rarest extremes), widened to `minOctaves` towards the
 * side with more music, at most the 88 keys; with `maxOctaves`, the window of that many octaves that
 * holds the most notes (ties → nearest to the music's centre).
 */
export function fitRange(weights: ArrayLike<number>, opts: FitOptions): KeyRange {
  let total = 0
  for (let m = PIANO_LOW; m <= PIANO_HIGH && m < weights.length; m++) total += weights[m]
  const clipped = new Float64Array(128)
  for (let m = PIANO_LOW; m <= PIANO_HIGH && m < weights.length; m++) clipped[m] = Math.max(0, weights[m])
  const minOct = Math.max(1, Math.min(opts.minOctaves, opts.maxOctaves))
  if (!(total > 0)) return centred(DEFAULT_RANGE, minOct, Math.min(opts.maxOctaves, octaveCount(DEFAULT_RANGE)))
  const out = opts.outliers ?? 0.005
  const lo = quantileIndex(clipped, total, out)
  const hi = quantileIndex(clipped, total, 1 - out)
  const median = quantileIndex(clipped, total, 0.5)
  let range = octaveRange(lo, hi)
  // widen to the minimum, one octave at a time on the side with more weight just outside
  while (octaveCount(range) < minOct && (range.low > PIANO_LOW || range.high < PIANO_HIGH)) {
    const below = range.low > PIANO_LOW ? sum(clipped, range.low - 12, range.low - 1) : -1
    const above = range.high < PIANO_HIGH ? sum(clipped, range.high + 1, range.high + 12) : -1
    const goDown =
      below > above || (below === above && median - range.low < range.high - median && range.low > PIANO_LOW) || above < 0
    range = goDown ? octaveRange(range.low - 12, range.high) : octaveRange(range.low, range.high + 12)
  }
  if (octaveCount(range) <= opts.maxOctaves) return range
  // too wide for the screen: the window of maxOctaves octaves holding the most notes
  let best: KeyRange | null = null
  let bestWeight = -1
  let bestDist = Infinity
  for (let c = Math.floor(PIANO_LOW / 12) * 12; c + 12 * opts.maxOctaves - 1 <= PIANO_HIGH + 11; c += 12) {
    const cand = octaveRange(c, c + 12 * opts.maxOctaves - 1)
    if (octaveCount(cand) < opts.maxOctaves && cand.low > PIANO_LOW && cand.high < PIANO_HIGH) continue
    const w = sum(clipped, cand.low, cand.high)
    const dist = Math.abs((cand.low + cand.high) / 2 - median)
    if (w > bestWeight + 1e-9 || (Math.abs(w - bestWeight) <= 1e-9 && dist < bestDist)) {
      best = cand
      bestWeight = w
      bestDist = dist
    }
  }
  return best ?? range
}

/** The harmonium's own keys, C3–C6 (37: three octaves and the top C). */
export const HARMONIUM_RANGE: KeyRange = { low: HARMONIUM_LOW, high: HARMONIUM_HIGH }

export type LiveKeyboard = 'piano' | 'harmonium'

/**
 * The keys the live panel shows: on the harmonium always its 37 (notes outside fold onto them), on
 * the piano the range fitted to the song's notes and the panel's width (`width` css px).
 */
export function liveRange(keyboard: LiveKeyboard, weights: ArrayLike<number>, width: number): KeyRange {
  if (keyboard === 'harmonium') return HARMONIUM_RANGE
  return fitRange(weights, { minOctaves: 4, maxOctaves: maxOctavesFor(width) })
}

function sum(w: ArrayLike<number>, a: number, b: number): number {
  let s = 0
  for (let m = Math.max(0, a); m <= Math.min(w.length - 1, b); m++) s += w[m]
  return s
}

function centred(r: KeyRange, minOct: number, maxOct: number): KeyRange {
  let range = r
  while (octaveCount(range) > maxOct && range.high - range.low > 12) range = octaveRange(range.low + 12, range.high)
  while (octaveCount(range) < minOct && (range.low > PIANO_LOW || range.high < PIANO_HIGH)) {
    range = range.low - 12 >= PIANO_LOW - 9 ? octaveRange(range.low - 12, range.high) : octaveRange(range.low, range.high + 12)
  }
  return range
}

/** A note mapped onto the shown keys: `fold` −1 = it is lower than the range, +1 = higher. */
export interface Folded {
  key: number
  fold: -1 | 0 | 1
}

/** Moves out-of-range notes by whole octaves to the nearest edge octave (pitch class kept). */
export function foldNote(midi: number, r: KeyRange): Folded {
  if (midi < r.low) {
    let k = midi + 12 * Math.ceil((r.low - midi) / 12)
    if (k > r.high) k = r.low
    return { key: k, fold: -1 }
  }
  if (midi > r.high) {
    let k = midi - 12 * Math.ceil((midi - r.high) / 12)
    if (k < r.low) k = r.high
    return { key: k, fold: 1 }
  }
  return { key: midi, fold: 0 }
}

/** Absolute white-key position of a note (black keys: the white key on their left). */
function whitePos(midi: number): number {
  return Math.floor(midi / 12) * 7 + WHITE_INDEX[((midi % 12) + 12) % 12]
}

export interface KeyRect {
  midi: number
  black: boolean
  /** css px, relative to the keyboard's left edge */
  x: number
  w: number
  /** key length (css px) */
  h: number
}

export interface KeyboardLayout {
  range: KeyRange
  width: number
  /** white key width / length */
  whiteW: number
  whiteH: number
  blackH: number
  /** by MIDI number (undefined outside the range) */
  keys: (KeyRect | undefined)[]
  whites: KeyRect[]
  blacks: KeyRect[]
  /** falling-note lane of a key: [x, w] */
  lane(midi: number): [number, number]
}

/** Lays out `range` across `width` css px; the white key length follows the key width. */
export function layoutKeyboard(range: KeyRange, width: number, opts: { maxHeight?: number; minHeight?: number } = {}): KeyboardLayout {
  const n = Math.max(1, whiteCount(range))
  const whiteW = width / n
  const whiteH = Math.min(opts.maxHeight ?? 132, Math.max(opts.minHeight ?? 56, whiteW * 4.4))
  const blackH = whiteH * BLACK_LENGTH
  const first = whitePos(range.low)
  const keys: (KeyRect | undefined)[] = new Array(128)
  const whites: KeyRect[] = []
  const blacks: KeyRect[] = []
  for (let m = range.low; m <= range.high; m++) {
    if (isBlack(m)) {
      const octaveX = (Math.floor(m / 12) * 7 - first) * whiteW
      const center = octaveX + (((m % 12) + 0.5) * 7 * whiteW) / 12
      const w = whiteW * BLACK_WIDTH
      const rect: KeyRect = { midi: m, black: true, x: center - w / 2, w, h: blackH }
      keys[m] = rect
      blacks.push(rect)
    } else {
      const rect: KeyRect = { midi: m, black: false, x: (whitePos(m) - first) * whiteW, w: whiteW, h: whiteH }
      keys[m] = rect
      whites.push(rect)
    }
  }
  return {
    range,
    width,
    whiteW,
    whiteH,
    blackH,
    keys,
    whites,
    blacks,
    lane(midi) {
      const k = keys[midi]
      if (!k) return [0, 0]
      const inset = k.black ? Math.max(0.5, k.w * 0.06) : Math.max(1, k.w * 0.12)
      return [k.x + inset, Math.max(1, k.w - 2 * inset)]
    },
  }
}

/** Octaves that fit `width` css px: ~3 on phones (keys stay tappable-looking), else ≥ 11 px white keys. */
export function maxOctavesFor(width: number): number {
  if (width < 640) return 3
  return Math.max(4, Math.floor(width / (7 * 11)))
}

const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

/** "C", "F♯" / "G♭": the note's name without the octave (what is printed on a lit key). */
export function pitchName(midi: number, spelling: 'sharp' | 'flat' = 'sharp'): string {
  const pc = ((midi % 12) + 12) % 12
  return (spelling === 'flat' ? NAMES_FLAT : NAMES_SHARP)[pc]
}

/** "C4", "F♯3" / "G♭3" (scientific pitch notation, middle C = C4). */
export function noteName(midi: number, spelling: 'sharp' | 'flat' = 'sharp'): string {
  return `${pitchName(midi, spelling)}${Math.floor(midi / 12) - 1}`
}
