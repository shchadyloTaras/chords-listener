// Song sections — intro, verse, pre-chorus, chorus, bridge, outro — found in the chord sheet's bars,
// so the chords can be shown part by part ("these are the verse's, these the chorus's"). Pure.
//
// 1. Each bar becomes its chord per beat (root + major/minor; extensions and slash basses dropped)
//    and its loudness (the waveform envelope, dB against the song's median).
// 2. Repeats (after Mauch's greedy repetition search): of the candidate segments (4–16 bars), the
//    one with the most repeated bars — length × (occurrences − 1) — becomes a group (A, B, …), its
//    bars are taken, and the search runs again on what is left. Two bars match when ≥ 75 % of their
//    beats agree (the same root with another quality counts half); a segment matches when ≥ 90 % of
//    its bars do.
// 3. Consecutive occurrences of a group merge into one section; what no group took becomes one-off
//    sections. A long section (> 12 bars) splits where the loudness steps by ≥ 3 dB on the 4-bar grid
//    (a song on one chord loop: quiet verse / loud chorus).
// 4. Names: the chorus is the repeated group with the highest score — its loudness (z) + 0.5 for 3+
//    occurrences + 0.5 when it first comes after another repeated group + 0.5 when the same group
//    leads into it every time; the verse is the repeated group that leads into the chorus (else the
//    first repeated group); a short group (≤ 8 bars) right before the chorus at least twice is the
//    pre-chorus; a one-off of ≥ 4 bars in the second half, before the last chorus, is the bridge; one-offs
//    at the start / end are the intro / outro. When the chorus does not stand out (its score is less
//    than 0.5 above the runner-up) the repeated groups keep neutral names ("Частина A").

import type { Bar } from './bars'
import { isMinorQuality } from './chord'
import type { DisplayChord, UniqueChord } from './display'

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'instrumental' | 'outro' | 'part'

/** Every kind, in the order a menu offers them. */
export const SECTION_KINDS: readonly SectionKind[] = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'instrumental', 'outro', 'part']

export interface SongSection {
  /** the same letter = the same music, repeated */
  group: string
  kind: SectionKind
  /** occurrence of this group, 1-based, and how many times the group plays */
  n: number
  of: number
  /** bars [startBar, endBar) of the sheet, and their time range */
  startBar: number
  endBar: number
  start: number
  end: number
}

export interface SectionInput {
  bars: readonly Bar[]
  /** the track's waveform peaks (0..1), spread evenly over 0..`duration` */
  waveform?: readonly number[] | null
  duration: number
  /** where the song starts (a fragment of a video / a recording linked to one: lib/viewWindow); 0 by default */
  start?: number
}

/** Two phrases are the same music when they agree this well (0..1): bar by bar and as a whole. */
const PHRASE_MATCH = 0.62
/** A section longer than this splits where the loudness steps. */
const SPLIT_OVER = 12
const LOUDNESS_STEP_DB = 2.5
/** The chorus must beat the runner-up by this much to be named. */
const CHORUS_MARGIN = 0.5

/**
 * A bar as a vector: its chords' share of the bar by root and major/minor (24) and, at half weight,
 * by root alone (12) — so Am7 vs Am, or a chord a beat early, still mostly agree.
 */
function barVector(bar: Bar): Float64Array {
  const v = new Float64Array(36)
  const beats = Math.max(1, bar.beats)
  for (const s of bar.slots) {
    if (s.isNone || s.rootPc == null) continue
    const w = s.span / beats
    v[s.rootPc * 2 + (isMinorQuality(s.quality) ? 1 : 0)] += w
    v[24 + s.rootPc] += 0.5 * w
  }
  return v
}

function cosine(a: Float64Array, b: Float64Array): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
}

/** Loudness of each bar in dB, relative to the song's median bar. */
function barLoudness(bars: readonly Bar[], waveform: readonly number[] | null | undefined, duration: number): number[] {
  if (!waveform?.length || !(duration > 0)) return bars.map(() => 0)
  const per = duration / waveform.length
  const db = bars.map((bar) => {
    const a = Math.max(0, Math.floor(bar.start / per))
    const b = Math.min(waveform.length, Math.max(a + 1, Math.ceil(bar.end / per)))
    let sum = 0
    for (let i = a; i < b; i++) sum += waveform[i] * waveform[i]
    return 10 * Math.log10(Math.max(1e-8, sum / (b - a)))
  })
  const sorted = [...db].sort((x, y) => x - y)
  const median = sorted[sorted.length >> 1]
  return db.map((v) => v - median)
}

/** A group's letter: A … Z, then A2 … Z2, … */
function letterAt(i: number): string {
  return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26) + 1) : '')
}

interface Segment {
  group: string | null
  startBar: number
  endBar: number
}

/** The song's sections, in order, covering every bar. [] for a sheet without chords. */
export function detectSections(input: SectionInput): SongSection[] {
  const { bars } = input
  const n = bars.length
  const vec = bars.map(barVector)
  const voiced = vec.map((v) => v.some((x) => x > 0))
  if (!voiced.some(Boolean)) return []
  const loud = barLoudness(bars, input.waveform, input.duration)
  const sim: Float32Array[] = vec.map(() => new Float32Array(n))
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const v = cosine(vec[i], vec[j])
      sim[i][j] = v
      sim[j][i] = v
    }

  // bar-by-bar agreement of two stretches in O(1): prefix sums along each diagonal of `sim`
  const diag: Float64Array[] = []
  for (let d = 0; d < n; d++) {
    const run = new Float64Array(n - d + 1)
    for (let t = 0; t < n - d; t++) run[t + 1] = run[t] + sim[t][t + d]
    diag.push(run)
  }
  // a stretch of bars as a whole (prefix sums of the bar vectors: shift-tolerant, the same chords a
  // bar early still match)
  const prefix = new Float64Array((n + 1) * 36)
  for (let i = 0; i < n; i++) for (let d = 0; d < 36; d++) prefix[(i + 1) * 36 + d] = prefix[i * 36 + d] + vec[i][d]
  const wholeCos = (a: number, b: number, len: number): number => {
    let ab = 0
    let aa = 0
    let bb = 0
    for (let d = 0; d < 36; d++) {
      const x = prefix[(a + len) * 36 + d] - prefix[a * 36 + d]
      const y = prefix[(b + len) * 36 + d] - prefix[b * 36 + d]
      ab += x * y
      aa += x * x
      bb += y * y
    }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
  }
  /** How alike bars [a, a+len) and [b, b+len) are: bar by bar and as a whole. */
  const stretchSim = (a: number, b: number, len: number): number => {
    const lo = Math.min(a, b)
    const run = diag[Math.abs(b - a)]
    return 0.5 * ((run[lo + len] - run[lo]) / len) + 0.5 * wholeCos(a, b, len)
  }
  /** The best match of [i, j) anywhere else in the song (not overlapping it). */
  const repeatOf = (i: number, j: number): number => {
    const len = j - i
    let best = 0
    for (let p = 0; p + len <= n; p++) if (p + len <= i || p >= j) best = Math.max(best, stretchSim(i, p, len))
    return best
  }

  // sections: the split of the bars into blocks of the usual lengths that repeat best — each block
  // scores its best match elsewhere, weighted by its length, with a prior for 8- and 16-bar sections;
  // the song's first and last few bars may form a short block (an intro / outro tail)
  const LENGTH_PRIOR = new Map([
    [4, 0],
    [6, -0.05],
    [8, 0.12],
    [12, 0],
    [16, 0.08],
  ])
  const score = new Float64Array(n + 1).fill(-Infinity)
  const from = new Int32Array(n + 1).fill(-1)
  score[0] = 0
  for (let j = 1; j <= n; j++) {
    const options: [number, number][] = [...LENGTH_PRIOR].map(([len, prior]) => [len, prior])
    for (let len = 1; len <= 3; len++) if (j === len || j === n) options.push([len, 0])
    for (const [len, prior] of options) {
      const i = j - len
      if (i < 0 || score[i] === -Infinity) continue
      const v = score[i] + len * ((len <= 3 ? 0.5 : repeatOf(i, j)) + prior)
      if (v > score[j]) {
        score[j] = v
        from[j] = i
      }
    }
  }
  const blocks: [number, number][] = []
  for (let j = n; j > 0; j = from[j]) blocks.unshift([from[j], j])

  // group the blocks: a block joins the group of the same length it matches best on average
  const groups: { len: number; blocks: number[] }[] = []
  const blockGroup: number[] = []
  blocks.forEach(([i, j], b) => {
    let best = -1
    let bestSim = PHRASE_MATCH
    groups.forEach((g, gi) => {
      if (g.len !== j - i) return
      const avg = g.blocks.reduce((acc, ob) => acc + stretchSim(i, blocks[ob][0], j - i), 0) / g.blocks.length
      if (avg >= bestSim) {
        bestSim = avg
        best = gi
      }
    })
    if (best < 0) {
      best = groups.length
      groups.push({ len: j - i, blocks: [] })
    }
    groups[best].blocks.push(b)
    blockGroup.push(best)
  })
  let letter = 0
  const letterOf = new Map<number, string>()
  const segments: Segment[] = blocks.map(([i, j], b) => {
    const g = blockGroup[b]
    const repeatedGroup = groups[g].blocks.length >= 2
    if (repeatedGroup && !letterOf.has(g)) letterOf.set(g, letterAt(letter++))
    return { group: repeatedGroup ? letterOf.get(g)! : null, startBar: i, endBar: j }
  })

  // merge: consecutive occurrences of a group; chord-less edges into their neighbour
  const merged: Segment[] = []
  for (const s of segments) {
    const prev = merged[merged.length - 1]
    if (prev && s.group && prev.group === s.group && s.endBar - prev.startBar <= 16) prev.endBar = s.endBar
    else merged.push({ ...s })
  }
  const silent = (s: Segment) => !voiced.slice(s.startBar, s.endBar).some(Boolean)
  while (merged.length > 1 && silent(merged[0])) merged[1].startBar = merged.shift()!.startBar
  while (merged.length > 1 && silent(merged[merged.length - 1])) merged[merged.length - 2].endBar = merged.pop()!.endBar

  // split long sections where the loudness steps (one chord loop for a whole song)
  const split: Segment[] = []
  const cut = new Set<string>()
  for (const s of merged) {
    if (s.endBar - s.startBar <= SPLIT_OVER) {
      split.push(s)
      continue
    }
    const block = (a: number) => {
      const end = Math.min(s.endBar, a + 4)
      let sum = 0
      for (let k = a; k < end; k++) sum += loud[k]
      return sum / (end - a)
    }
    let from = s.startBar
    let level = block(from)
    for (let a = s.startBar + 4; a < s.endBar; a += 4) {
      const next = block(a)
      if (Math.abs(next - level) >= LOUDNESS_STEP_DB) {
        if (s.group) cut.add(s.group)
        split.push({ group: s.group, startBar: from, endBar: a })
        from = a
      }
      level = next
    }
    split.push({ group: s.group, startBar: from, endBar: s.endBar })
  }
  const meanLoud = (s: Segment) => {
    let sum = 0
    for (let k = s.startBar; k < s.endBar; k++) sum += loud[k]
    return sum / (s.endBar - s.startBar)
  }
  // back-to-back sections of a group with a loudness step between them count as cut too
  for (let i = 1; i < split.length; i++) {
    const g = split[i].group
    if (g && split[i - 1].group === g && Math.abs(meanLoud(split[i]) - meanLoud(split[i - 1])) >= LOUDNESS_STEP_DB) cut.add(g)
  }
  // a group cut at a loudness step: its quiet and loud parts become different groups (A → A, A′),
  // when both still repeat (a louder second verse stays a verse)
  const byGroup = new Map<string, Segment[]>()
  for (const s of split) if (s.group && cut.has(s.group)) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s])
  for (const [g, list] of byGroup) {
    const levels = list.map(meanLoud)
    const lo = Math.min(...levels)
    const hi = Math.max(...levels)
    if (hi - lo < LOUDNESS_STEP_DB) continue
    const mid = (lo + hi) / 2
    const loud = list.filter((_, i) => levels[i] > mid)
    if (loud.length < 2 || list.length - loud.length < 2) continue
    for (const s of loud) s.group = `${g}′`
  }

  // a group playing only as the song's first and last section (an outro repeating the intro): two one-offs
  if (split.length > 2) {
    const g = split[0].group
    if (g && split.at(-1)!.group === g && split.filter((s) => s.group === g).length === 2) split[0].group = split.at(-1)!.group = null
  }

  // one-offs get their own letters, then every group is lettered in the order it first comes
  // (A′ keeps the letter of its A); then count occurrences
  for (const s of split) if (!s.group) s.group = `#${letter++}`
  const relettered = new Map<string, string>()
  for (const s of split) {
    const base = s.group!.replace('′', '')
    if (!relettered.has(base)) relettered.set(base, letterAt(relettered.size))
    s.group = relettered.get(base)! + (s.group!.endsWith('′') ? '′' : '')
  }
  const count = new Map<string, number>()
  for (const s of split) count.set(s.group!, (count.get(s.group!) ?? 0) + 1)
  const repeated = [...count].filter(([, c]) => c >= 2).map(([g]) => g)

  // name the groups
  const kinds = new Map<string, SectionKind>()
  const loudOf = new Map<string, number>()
  for (const g of repeated) {
    const ls = split.filter((s) => s.group === g)
    loudOf.set(g, ls.reduce((a, s) => a + meanLoud(s) * (s.endBar - s.startBar), 0) / ls.reduce((a, s) => a + s.endBar - s.startBar, 0))
  }
  const firstIndex = (g: string) => split.findIndex((s) => s.group === g)
  const leadIn = (g: string): string | null => {
    // the group that comes right before every occurrence of g (but the first one at the start)
    let lead: string | null = null
    for (let i = 0; i < split.length; i++) {
      if (split[i].group !== g || i === 0) continue
      const before = split[i - 1].group!
      if (lead === null) lead = before
      else if (lead !== before) return null
    }
    return lead
  }
  if (repeated.length) {
    const levels = repeated.map((g) => loudOf.get(g)!)
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length
    const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length) || 1
    const scored = repeated
      .map((g) => {
        let score = (loudOf.get(g)! - mean) / sd
        if (count.get(g)! >= 3) score += 0.5
        const first = firstIndex(g)
        if (split.slice(0, first).some((s) => repeated.includes(s.group!))) score += 0.5
        const lead = leadIn(g)
        if (lead && lead !== g && repeated.includes(lead)) score += 0.5
        return { g, score }
      })
      .sort((x, y) => y.score - x.score)
    const chorus = scored[0]
    const clear = scored.length === 1 ? count.get(chorus.g)! >= 2 && split.length > count.get(chorus.g)! : chorus.score - scored[1].score >= CHORUS_MARGIN
    if (clear) {
      kinds.set(chorus.g, 'chorus')
      const lead = leadIn(chorus.g)
      // a short group leading into the chorus, itself led by another repeated group: the pre-chorus
      if (lead && lead !== chorus.g && repeated.includes(lead)) {
        const len = split.filter((s) => s.group === lead).reduce((a, s) => Math.max(a, s.endBar - s.startBar), 0)
        const leadLead = leadIn(lead)
        if (len <= 8 && leadLead && leadLead !== lead && repeated.includes(leadLead)) {
          kinds.set(lead, 'prechorus')
          kinds.set(leadLead, 'verse')
        } else kinds.set(lead, 'verse')
      }
      if (![...kinds.values()].includes('verse')) {
        const verse = repeated.filter((g) => !kinds.has(g)).sort((x, y) => firstIndex(x) - firstIndex(y))[0]
        if (verse) kinds.set(verse, 'verse')
      }
    }
  }

  const songStart = input.start ?? 0
  const lastChorus = split.reduce((last, s, i) => (kinds.get(s.group!) === 'chorus' ? i : last), -1)
  const sections: SongSection[] = []
  const seen = new Map<string, number>()
  split.forEach((s, i) => {
    const g = s.group!
    let kind: SectionKind = kinds.get(g) ?? 'part'
    const oneOff = count.get(g) === 1
    if (oneOff) {
      const from = bars[s.startBar].start
      const len = s.endBar - s.startBar
      if (i === 0 && split.length > 1) kind = 'intro'
      else if (i === split.length - 1 && split.length > 1) kind = 'outro'
      else if (lastChorus > i && len >= 4 && from - songStart >= 0.5 * (input.duration - songStart)) kind = 'bridge'
    }
    const k = (seen.get(g) ?? 0) + 1
    seen.set(g, k)
    sections.push({
      group: g,
      kind,
      n: k,
      of: count.get(g)!,
      startBar: s.startBar,
      endBar: s.endBar,
      start: bars[s.startBar].start,
      end: bars[s.endBar - 1].end,
    })
  })
  return sections
}

/** A part of the song: a group of sections playing the same music (verse 1, verse 2, …). */
export interface SongPart {
  group: string
  kind: SectionKind
  sections: SongSection[]
}

/** The sections grouped by their music, in the order the parts first come. */
export function songParts(sections: readonly SongSection[]): SongPart[] {
  const parts: SongPart[] = []
  for (const s of sections) {
    const part = parts.find((p) => p.group === s.group)
    if (part) part.sections.push(s)
    else parts.push({ group: s.group, kind: s.kind, sections: [s] })
  }
  return parts
}

/** The user's names for the parts (keyed by `partKeys`) over the detected ones; unknown names ignored. */
export function withKinds(sections: readonly SongSection[], kinds: Readonly<Record<string, string>> | null | undefined): SongSection[] {
  if (!kinds || typeof kinds !== 'object' || !Object.keys(kinds).length) return [...sections]
  const keys = partKeys(sections)
  return sections.map((s) => {
    const kind = kinds[keys.get(s.group)!]
    return kind && (SECTION_KINDS as readonly string[]).includes(kind) ? { ...s, kind: kind as SectionKind } : s
  })
}

/** The chords a part plays (every occurrence), in order of first appearance, with their counts. */
export function partChords(chords: readonly DisplayChord[], part: SongPart): UniqueChord[] {
  const map = new Map<string, UniqueChord>()
  for (const c of chords) {
    if (c.isNone) continue
    const inside = part.sections.some((s) => c.start < s.end - 1e-6 && c.end > s.start + 1e-6)
    if (!inside) continue
    const u = map.get(c.label)
    if (u) {
      u.count++
      u.seconds += c.end - c.start
    } else map.set(c.label, { label: c.label, rootPc: c.rootPc, quality: c.quality, count: 1, seconds: c.end - c.start, firstIndex: c.index })
  }
  return [...map.values()]
}

/**
 * Stable keys for the user's names of parts: a part is known by when it first starts (whole seconds),
 * which survives a re-detection that letters the groups differently.
 */
export function partKeys(sections: readonly SongSection[]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const s of sections) if (!keys.has(s.group)) keys.set(s.group, String(Math.round(s.start)))
  return keys
}
