// Display pipeline: detected segments → (simplify) → (transpose + spell) → merged display chords.

import type { ChordQuality, ChordSegment } from '../../types'
import { formatChord, isNoChordLabel, parseChord, simplifyQuality, type ParsedChord } from './chord'
import type { Spelling } from './notes'

export interface DisplayChord {
  /** index in the display list */
  index: number
  start: number
  end: number
  /** display label (transposed / simplified / spelled); "N" for no chord */
  label: string
  rootPc: number | null
  quality: ChordQuality | null
  bassPc: number | null
  isNone: boolean
  /** duration-weighted confidence 0..1 */
  confidence: number
  /** inclusive range of source indices in track.chords merged into this chord */
  srcStart: number
  srcEnd: number
}

export interface DisplayOptions {
  transpose: number
  simplify: boolean
  spelling: Spelling
}

export const LOW_CONFIDENCE = 0.5

/** Transforms one source label for display. Unknown labels pass through unchanged. */
export function displayLabel(label: string, opts: DisplayOptions): { label: string; parsed: ParsedChord | null } {
  if (isNoChordLabel(label)) return { label: 'N', parsed: null }
  const p = parseChord(label)
  if (!p) return { label, parsed: null }
  const quality = opts.simplify ? simplifyQuality(p.quality) : p.quality
  const bassPc = opts.simplify || p.bassPc == null ? null : p.bassPc + opts.transpose
  const out = formatChord({ rootPc: p.rootPc + opts.transpose, quality, bassPc }, opts.spelling)
  return { label: out, parsed: parseChord(out) }
}

/**
 * Builds the display list. Consecutive segments that end up with the same display label
 * (e.g. G and Gsus4 after simplifying) are merged so the UI never shows "G → G".
 */
export function buildDisplayChords(src: ChordSegment[], opts: DisplayOptions): DisplayChord[] {
  const out: DisplayChord[] = []
  let weighted = 0
  for (let i = 0; i < src.length; i++) {
    const seg = src[i]
    if (!(seg.end > seg.start)) continue
    const { label, parsed } = displayLabel(seg.label, opts)
    const dur = seg.end - seg.start
    const conf = Number.isFinite(seg.confidence) ? seg.confidence : 1
    const prev = out[out.length - 1]
    if (prev && prev.label === label && Math.abs(prev.end - seg.start) < 0.05) {
      weighted += conf * dur
      prev.end = seg.end
      prev.srcEnd = i
      prev.confidence = weighted / (prev.end - prev.start)
      continue
    }
    weighted = conf * dur
    out.push({
      index: out.length,
      start: seg.start,
      end: seg.end,
      label,
      rootPc: parsed?.rootPc ?? null,
      quality: parsed?.quality ?? null,
      bassPc: parsed?.bassPc ?? null,
      isNone: label === 'N',
      confidence: conf,
      srcStart: i,
      srcEnd: i,
    })
  }
  return out
}

/** Index of the chord sounding at time t (binary search), or -1 outside all chords. */
export function chordIndexAt(chords: { start: number; end: number }[], t: number): number {
  let lo = 0
  let hi = chords.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = chords[mid]
    if (t < c.start) hi = mid - 1
    else if (t >= c.end) lo = mid + 1
    else return mid
  }
  return -1
}

/** First index whose `end` is after t (for range scans). */
export function firstEndingAfter(items: { end: number }[], t: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].end > t) hi = mid
    else lo = mid + 1
  }
  return lo
}

export interface UniqueChord {
  label: string
  rootPc: number | null
  quality: ChordQuality | null
  /** number of separate occurrences */
  count: number
  /** total seconds */
  seconds: number
  firstIndex: number
}

/** Unique chords (no "N") in order of first appearance. */
export function uniqueChords(chords: DisplayChord[]): UniqueChord[] {
  const map = new Map<string, UniqueChord>()
  for (const c of chords) {
    if (c.isNone) continue
    const u = map.get(c.label)
    if (u) {
      u.count++
      u.seconds += c.end - c.start
    } else {
      map.set(c.label, {
        label: c.label,
        rootPc: c.rootPc,
        quality: c.quality,
        count: 1,
        seconds: c.end - c.start,
        firstIndex: c.index,
      })
    }
  }
  return [...map.values()]
}

/** Next chord after `index` that is not "N" (or -1). */
export function nextRealChord(chords: DisplayChord[], index: number): number {
  for (let i = index + 1; i < chords.length; i++) if (!chords[i].isNone) return i
  return -1
}

/** Previous chord before `index` that is not "N" (or -1). */
export function prevRealChord(chords: DisplayChord[], index: number): number {
  for (let i = Math.min(index, chords.length) - 1; i >= 0; i--) if (!chords[i].isNone) return i
  return -1
}
