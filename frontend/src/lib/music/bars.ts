// Bar grouping: split the song into bars (from downbeats / beats / tempo) and place chords
// on each bar's beat grid; chunk bars into lines and detect consecutive repeated lines.

import type { ChordQuality } from '../../types'
import { firstEndingAfter, LOW_CONFIDENCE, type DisplayChord } from './display'

export interface GridInput {
  duration: number
  beats?: number[] | null
  downbeats?: number[] | null
  tempo?: number | null
  timeSignature?: number | null
}

export interface BarFrame {
  index: number
  start: number
  end: number
  /** beat boundaries: [start, …inner beats…, end] → beats = boundaries.length - 1 */
  boundaries: number[]
  /** short leading bar (anacrusis / intro offset) */
  pickup: boolean
}

export interface BarSlot {
  /** first display chord index covered by this slot */
  chordIndex: number
  /** last display chord index covered (short chords absorbed into this slot) */
  lastChordIndex: number
  label: string
  rootPc: number | null
  quality: ChordQuality | null
  isNone: boolean
  /** beat position within the bar (0-based) and length in beats */
  beat: number
  span: number
  /** time range of this slot inside the bar (start = seek target) */
  start: number
  end: number
  /** the chord was already sounding when the bar began */
  continued: boolean
  lowConfidence: boolean
}

export interface Bar extends BarFrame {
  beats: number
  slots: BarSlot[]
}

export interface Line {
  index: number
  bars: Bar[]
  start: number
  end: number
  pickup: boolean
  /** identity of the musical content (labels + rhythm), for repeat detection */
  signature: string
}

export interface LineGroup {
  /** the representative (first) line */
  line: Line
  /** all lines folded into this group (length = repeat count) */
  lines: Line[]
}

const EPS = 0.02

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function cleanTimes(xs: number[] | null | undefined, duration: number): number[] {
  const out: number[] = []
  for (const x of [...(xs ?? [])].filter(Number.isFinite).sort((a, b) => a - b)) {
    if (x < 0 || x >= duration) continue
    if (out.length && x - out[out.length - 1] < 0.1) continue
    out.push(x)
  }
  return out
}

/**
 * Bar boundaries for the whole song. Priority: downbeats → every N-th beat → tempo grid →
 * a fixed 2-second grid. Gaps in tracker output are filled with interpolated bars, a short
 * lead-in becomes a pickup bar, and the tail is extended / absorbed so bars cover 0..duration.
 */
export function buildBarGrid(input: GridInput): BarFrame[] {
  const duration = input.duration
  if (!(duration > 0)) return []
  const ts = Math.min(12, Math.max(2, Math.round(input.timeSignature || 4)))
  const beats = cleanTimes(input.beats, duration)

  let bounds = cleanTimes(input.downbeats, duration)
  if (bounds.length < 2 && beats.length >= ts * 2) bounds = beats.filter((_, i) => i % ts === 0)
  if (bounds.length < 2) {
    const tempo = input.tempo && input.tempo > 20 && input.tempo < 400 ? input.tempo : 120
    const barLen = (60 / tempo) * ts
    bounds = []
    for (let t = 0; t < duration - barLen * 0.35; t += barLen) bounds.push(t)
    if (!bounds.length) bounds = [0]
  }

  // Typical bar length: downbeat spacing, unless beats / tempo clearly disagree (sparse downbeats).
  const diffs = bounds.slice(1).map((b, i) => b - bounds[i])
  let L = median(diffs) || duration
  const beatDiffs = beats.slice(1).map((b, i) => b - beats[i])
  const hint =
    beatDiffs.length >= 2
      ? median(beatDiffs) * ts
      : input.tempo && input.tempo > 20 && input.tempo < 400
        ? (60 / input.tempo) * ts
        : 0
  if (hint > 0 && Math.abs(L - hint) / hint > 0.25) L = hint

  // Fill gaps where the tracker lost the downbeat.
  const filled: number[] = [bounds[0]]
  for (let i = 1; i < bounds.length; i++) {
    const gap = bounds[i] - bounds[i - 1]
    if (gap > L * 1.6) {
      const k = Math.round(gap / L)
      for (let j = 1; j < k; j++) filled.push(bounds[i - 1] + (gap * j) / k)
    }
    filled.push(bounds[i])
  }
  bounds = filled

  // Lead-in: extrapolate whole bars backwards, then a pickup or absorb the remainder.
  while (bounds[0] > L * 1.05) bounds.unshift(bounds[0] - L)
  let pickup = false
  if (bounds[0] > EPS) {
    if (bounds[0] < L * 0.35) bounds[0] = 0
    else {
      pickup = bounds[0] < L * 0.85
      bounds.unshift(0)
    }
  } else bounds[0] = 0

  // Tail: extrapolate, then absorb a tiny last fragment into the previous bar.
  while (bounds[bounds.length - 1] + L * 1.05 < duration) bounds.push(bounds[bounds.length - 1] + L)
  if (bounds.length > 1 && duration - bounds[bounds.length - 1] < L * 0.35) bounds.pop()
  bounds.push(duration)

  const beatLen = L / ts
  const frames: BarFrame[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]
    const end = bounds[i + 1]
    const len = end - start
    const regular = len > L * 0.85 && len < L * 1.15
    const n = regular ? ts : Math.min(ts * 2, Math.max(1, Math.round(len / beatLen)))
    const inner = beats.filter((b) => b > start + beatLen * 0.3 && b < end - beatLen * 0.3)
    const boundaries =
      inner.length === n - 1
        ? [start, ...inner, end]
        : Array.from({ length: n + 1 }, (_, k) => start + (len * k) / n)
    frames.push({ index: i, start, end, boundaries, pickup: i === 0 && pickup })
  }
  return frames
}

/** Nearest beat boundary index for a time inside the bar. */
function quantize(boundaries: number[], t: number): number {
  let best = 0
  let bestD = Infinity
  for (let k = 0; k < boundaries.length; k++) {
    const d = Math.abs(boundaries[k] - t)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}

/**
 * Places display chords on each bar's beat grid. Chords too short to cover a beat are absorbed
 * into the neighbouring slot so every bar stays readable; the first slot always starts on beat 0
 * and the last one always ends on the barline.
 */
export function fillBars(frames: BarFrame[], chords: DisplayChord[]): Bar[] {
  return frames.map((f) => {
    const n = f.boundaries.length - 1
    const slots: BarSlot[] = []
    let longest: { c: DisplayChord; s: number; e: number } | null = null
    for (let i = firstEndingAfter(chords, f.start + EPS); i < chords.length && chords[i].start < f.end - EPS; i++) {
      const c = chords[i]
      const s = Math.max(c.start, f.start)
      const e = Math.min(c.end, f.end)
      if (e - s <= EPS) continue
      if (!longest || e - s > longest.e - longest.s) longest = { c, s, e }
      const q0 = quantize(f.boundaries, s)
      const q1 = quantize(f.boundaries, e)
      const last = slots[slots.length - 1]
      if (q1 <= q0) {
        // Too short to show at beat resolution: let the previous slot cover it.
        if (last) {
          last.lastChordIndex = c.index
          last.end = e
        }
        continue
      }
      if (last && last.label === c.label) {
        last.span = q1 - last.beat
        last.lastChordIndex = c.index
        last.end = e
        continue
      }
      if (last && q0 > last.beat + last.span) last.span = q0 - last.beat
      slots.push({
        chordIndex: c.index,
        lastChordIndex: c.index,
        label: c.label,
        rootPc: c.rootPc,
        quality: c.quality,
        isNone: c.isNone,
        beat: last ? Math.max(q0, last.beat + last.span) : q0,
        span: q1 - q0,
        start: s,
        end: e,
        continued: c.start < f.start - 0.05 && !last,
        lowConfidence: !c.isNone && c.confidence < LOW_CONFIDENCE,
      })
    }
    if (!slots.length && longest) {
      const { c, s, e } = longest
      slots.push({
        chordIndex: c.index,
        lastChordIndex: c.index,
        label: c.label,
        rootPc: c.rootPc,
        quality: c.quality,
        isNone: c.isNone,
        beat: 0,
        span: n,
        start: s,
        end: e,
        continued: c.start < f.start - 0.05,
        lowConfidence: !c.isNone && c.confidence < LOW_CONFIDENCE,
      })
    }
    if (slots.length) {
      const first = slots[0]
      first.span += first.beat
      first.beat = 0
      first.start = f.start
      const last = slots[slots.length - 1]
      last.span = n - last.beat
    }
    return { ...f, beats: n, slots }
  })
}

export function buildBars(input: GridInput, chords: DisplayChord[]): Bar[] {
  return fillBars(buildBarGrid(input), chords)
}

/** Index of the bar containing time t (binary search), or -1. */
export function barIndexAt(bars: { start: number; end: number }[], t: number): number {
  let lo = 0
  let hi = bars.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t < bars[mid].start) hi = mid - 1
    else if (t >= bars[mid].end) lo = mid + 1
    else return mid
  }
  return -1
}

export function barSignature(bar: Bar): string {
  return `${bar.beats}:` + bar.slots.map((s) => `${s.label}@${s.beat}+${s.span}`).join(',')
}

/** Chunks bars into lines of `perLine`; a pickup bar gets its own first line so phrases stay aligned. */
export function buildLines(bars: Bar[], perLine: number): Line[] {
  const size = Math.max(1, Math.round(perLine))
  const lines: Line[] = []
  const push = (chunk: Bar[], pickup: boolean) =>
    lines.push({
      index: lines.length,
      bars: chunk,
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      pickup,
      signature: chunk.map(barSignature).join('|'),
    })
  let i = 0
  if (bars[0]?.pickup) {
    push([bars[0]], true)
    i = 1
  }
  for (; i < bars.length; i += size) push(bars.slice(i, i + size), false)
  return lines
}

/** Folds consecutive identical lines (same chords on the same beats) into ×N groups. */
export function groupRepeats(lines: Line[]): LineGroup[] {
  const groups: LineGroup[] = []
  for (const line of lines) {
    const g = groups[groups.length - 1]
    if (
      g &&
      !line.pickup &&
      !g.line.pickup &&
      g.line.signature === line.signature &&
      g.line.bars.length === line.bars.length &&
      line.bars.some((b) => b.slots.some((s) => !s.isNone))
    ) {
      g.lines.push(line)
    } else groups.push({ line, lines: [line] })
  }
  return groups
}

/** Drops leading / trailing bars that contain no chord at all (silence, intro noise). */
export function trimSilentBars(bars: Bar[]): Bar[] {
  const silent = (b: Bar) => b.slots.every((s) => s.isNone)
  let a = 0
  let z = bars.length
  while (a < z && silent(bars[a])) a++
  while (z > a && silent(bars[z - 1])) z--
  return bars.slice(a, z)
}
