// Plain-text export formats for copying / downloading chords.

import type { CopyFormat } from '../../store'
import { buildLines, groupRepeats, trimSilentBars, type Bar, type Line } from './bars'
import type { DisplayChord } from './display'

export const NO_CHORD_TEXT = 'N.C.'

export interface SongMeta {
  title?: string | null
  artist?: string | null
  /** displayed (transposed) key name */
  keyName?: string | null
  tempo?: number | null
  timeSignature?: number | null
}

export interface ExportInput {
  meta: SongMeta
  /** display chords (already transposed / simplified) */
  chords: DisplayChord[]
  /** bars built from the same display chords */
  bars: Bar[]
  barsPerLine: number
  /** fold consecutive identical lines into "×N" */
  collapseRepeats?: boolean
}

export interface ExportRange {
  /** inclusive bar indices */
  fromBar: number
  toBar: number
}

/** "m:ss" (or "h:mm:ss") */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function slotText(label: string, isNone: boolean): string {
  return isNone ? NO_CHORD_TEXT : label
}

/** Text of one bar: its chords separated by spaces ("G G/B"); held chords repeat their name. */
export function barText(bar: Bar, bracket = false): string {
  if (!bar.slots.length) return bracket ? `[${NO_CHORD_TEXT}]` : NO_CHORD_TEXT
  return bar.slots.map((s) => (bracket ? `[${slotText(s.label, s.isNone)}]` : slotText(s.label, s.isNone))).join(' ')
}

function linesFor(input: ExportInput, range?: ExportRange): Line[] {
  const bars = range ? input.bars.slice(range.fromBar, range.toBar + 1) : input.bars
  const trimmed = trimSilentBars(bars)
  if (!trimmed.length) return []
  const perLine = input.barsPerLine
  // A pickup only stays a pickup when it is still the first bar of the export.
  const normalized = trimmed[0].pickup && trimmed[0] === input.bars[0] ? trimmed : trimmed.map((b) => ({ ...b, pickup: false }))
  return buildLines(normalized, perLine)
}

function renderLines(lines: Line[], collapse: boolean, bracket: boolean): string[] {
  const groups = collapse ? groupRepeats(lines) : lines.map((line) => ({ line, lines: [line] }))
  const cells = groups.map((g) => g.line.bars.map((b) => barText(b, bracket)))
  // Pad each column to a common width so the chart lines up in monospace fonts.
  const widths: number[] = []
  groups.forEach((g, gi) => {
    if (g.line.pickup) return
    cells[gi].forEach((c, j) => (widths[j] = Math.max(widths[j] ?? 0, c.length)))
  })
  return groups.map((g, gi) => {
    const row = cells[gi].map((c, j) => (g.line.pickup ? c : c.padEnd(widths[j] ?? 0))).join(' | ')
    const repeat = g.lines.length > 1 ? `  ×${g.lines.length}` : ''
    return `| ${row} |${repeat}`
  })
}

/** "| Am | F | C | G G/B |" lines, `barsPerLine` bars per line. */
export function formatBarsText(input: ExportInput, range?: ExportRange): string {
  const lines = linesFor(input, range)
  if (!lines.length) return NO_CHORD_TEXT
  return renderLines(lines, !!input.collapseRepeats, false).join('\n')
}

/** One chord change per line: "0:12  Am". No-chord stretches are skipped. */
export function formatTimestamps(input: ExportInput, range?: ExportRange): string {
  const from = range ? input.bars[range.fromBar]?.start ?? 0 : -Infinity
  const to = range ? input.bars[range.toBar]?.end ?? Infinity : Infinity
  const out: string[] = []
  let prev = ''
  for (const c of input.chords) {
    if (c.end <= from || c.start >= to) continue
    if (c.isNone) {
      prev = ''
      continue
    }
    if (c.label === prev) continue
    prev = c.label
    out.push(`${formatTime(Math.max(c.start, from))}  ${c.label}`)
  }
  return out.join('\n') || NO_CHORD_TEXT
}

/** ChordPro: directives header (whole song only) + bars with [chords]. */
export function formatChordPro(input: ExportInput, range?: ExportRange): string {
  const lines = linesFor(input, range)
  const body = lines.length ? renderLines(lines, !!input.collapseRepeats, true) : [`[${NO_CHORD_TEXT}]`]
  if (range) return body.join('\n')
  const { title, artist, keyName, tempo, timeSignature } = input.meta
  const head: string[] = []
  if (title) head.push(`{title: ${title}}`)
  if (artist) head.push(`{artist: ${artist}}`)
  if (keyName) head.push(`{key: ${keyName}}`)
  if (tempo && tempo > 0) head.push(`{tempo: ${Math.round(tempo)}}`)
  if (timeSignature) head.push(`{time: ${timeSignature}/4}`)
  return [...head, ...(head.length ? [''] : []), ...body].join('\n')
}

/** Unique chord names in order of first appearance: "Am F C G". */
export function formatUnique(input: ExportInput, range?: ExportRange): string {
  const from = range ? input.bars[range.fromBar]?.start ?? 0 : -Infinity
  const to = range ? input.bars[range.toBar]?.end ?? Infinity : Infinity
  const seen: string[] = []
  for (const c of input.chords) {
    if (c.isNone || c.end <= from || c.start >= to) continue
    if (!seen.includes(c.label)) seen.push(c.label)
  }
  return seen.join(' ') || NO_CHORD_TEXT
}

export function formatChords(format: CopyFormat, input: ExportInput, range?: ExportRange): string {
  switch (format) {
    case 'timestamps':
      return formatTimestamps(input, range)
    case 'chordpro':
      return formatChordPro(input, range)
    case 'unique':
      return formatUnique(input, range)
    default:
      return formatBarsText(input, range)
  }
}

/** File-system-safe base name for downloads. */
export function safeFileName(title: string | null | undefined, fallback = 'chords'): string {
  const cleaned = Array.from(title ?? '', (ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch)).join('')
  const base = cleaned.replace(/\s+/g, ' ').trim().slice(0, 80)
  return base || fallback
}
