// What of a chord can be played on a handpan: chord tones → tone fields, missing notes, song
// coverage and the transposition that suits the instrument best. Pure pitch-class math.

import type { ChordQuality } from '../../types'
import { parseChord, QUALITY_INTERVALS } from '../music/chord'
import { mod12 } from '../music/notes'
import type { HandpanScale } from './scales'

export type ToneRole = 'root' | 'third' | 'fifth' | 'seventh' | 'sixth' | 'ninth' | 'sus'
/** What a note of the instrument does in the current chord ("bass" = slash bass outside the chord). */
export type FieldRole = ToneRole | 'bass'

export interface ChordTone {
  pc: number
  /** semitones above the root (9th = 14) */
  interval: number
  role: ToneRole
}

export interface ChordTones {
  rootPc: number
  quality: ChordQuality
  tones: ChordTone[]
  /** slash bass when it is not one of the chord tones */
  bassPc: number | null
}

function roleOf(interval: number, quality: ChordQuality): ToneRole {
  switch (interval) {
    case 0:
      return 'root'
    case 3:
    case 4:
      return 'third'
    case 2:
    case 5:
      return 'sus'
    case 6:
    case 7:
    case 8:
      return 'fifth'
    case 9:
      return quality === 'dim7' ? 'seventh' : 'sixth'
    case 10:
    case 11:
      return 'seventh'
    default:
      return 'ninth'
  }
}

/** Chord tones (root first) with their function, via the shared chord parser. Null for "N" / unknown. */
export function chordTones(label: string): ChordTones | null {
  const p = parseChord(label)
  if (!p) return null
  const tones = QUALITY_INTERVALS[p.quality].map((interval) => ({
    pc: mod12(p.rootPc + interval),
    interval,
    role: roleOf(interval, p.quality),
  }))
  const bassPc = p.bassPc != null && !tones.some((x) => x.pc === p.bassPc) ? p.bassPc : null
  return { rootPc: p.rootPc, quality: p.quality, tones, bassPc }
}

export interface TonePlay extends ChordTone {
  /** note indices on the instrument (0 = ding, 1.. = tone fields) sounding this pitch class */
  fields: number[]
}

export interface HandpanPlayability {
  label: string
  rootPc: number
  /** every chord tone with the fields that play it (empty `fields` = missing) */
  tones: TonePlay[]
  missing: ChordTone[]
  /** chord tones available on the instrument */
  playable: number
  total: number
  /** playable / total, 0..1 */
  coverage: number
  full: boolean
  /** root and perfect fifth are both on the instrument (a "5" chord is always possible) */
  powerChord: boolean
  /** slash bass outside the chord, when there is one */
  bass: { pc: number; fields: number[] } | null
  /** role per note index (ding = 0), null for notes that are not in the chord */
  roles: (FieldRole | null)[]
}

const ROLE_RANK: Record<FieldRole, number> = { root: 0, third: 1, sus: 1, fifth: 2, seventh: 3, sixth: 3, ninth: 4, bass: 5 }

function fieldsFor(pc: number, scale: HandpanScale): number[] {
  const out: number[] = []
  scale.notes.forEach((n, i) => {
    if (n.pc === pc) out.push(i)
  })
  return out
}

function computePlayability(label: string, scale: HandpanScale): HandpanPlayability | null {
  const ct = chordTones(label)
  if (!ct) return null
  const tones: TonePlay[] = ct.tones.map((tone) => ({ ...tone, fields: fieldsFor(tone.pc, scale) }))
  const missing = tones.filter((x) => !x.fields.length).map(({ pc, interval, role }) => ({ pc, interval, role }))
  const playable = tones.length - missing.length
  const bass = ct.bassPc == null ? null : { pc: ct.bassPc, fields: fieldsFor(ct.bassPc, scale) }
  const roles: (FieldRole | null)[] = scale.notes.map(() => null)
  const assign = (fields: number[], role: FieldRole) => {
    for (const i of fields) {
      const cur = roles[i]
      if (cur == null || ROLE_RANK[role] < ROLE_RANK[cur]) roles[i] = role
    }
  }
  for (const tone of tones) assign(tone.fields, tone.role)
  if (bass) assign(bass.fields, 'bass')
  const has = (pc: number) => (scale.mask & (1 << pc)) !== 0
  return {
    label,
    rootPc: ct.rootPc,
    tones,
    missing,
    playable,
    total: tones.length,
    coverage: tones.length ? playable / tones.length : 0,
    full: missing.length === 0,
    powerChord: has(ct.rootPc) && has(mod12(ct.rootPc + 7)),
    bass,
    roles,
  }
}

const CACHE_LIMIT = 4000
const cache = new Map<string, HandpanPlayability | null>()

/** Memoized per (scale, label): cheap to call from every diagram on every render. */
export function playability(label: string, scale: HandpanScale): HandpanPlayability | null {
  const key = `${scale.key}\u0000${label}`
  if (cache.has(key)) return cache.get(key) ?? null
  const result = computePlayability(label, scale)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, result)
  return result
}

// ---------- song level ----------

export interface WeightedLabel {
  label: string
  /** importance, e.g. seconds the chord sounds */
  weight: number
}

interface PreparedChord {
  pcs: number[]
  weight: number
}

function prepare(chords: readonly WeightedLabel[]): PreparedChord[] {
  const out: PreparedChord[] = []
  for (const c of chords) {
    if (!(c.weight > 0)) continue
    const ct = chordTones(c.label)
    if (ct) out.push({ pcs: ct.tones.map((x) => x.pc), weight: c.weight })
  }
  return out
}

function coverageOf(items: PreparedChord[], mask: number, shift: number): number {
  let sum = 0
  let total = 0
  for (const c of items) {
    let have = 0
    for (const pc of c.pcs) if (mask & (1 << mod12(pc + shift))) have++
    sum += c.weight * (have / c.pcs.length)
    total += c.weight
  }
  return total > 0 ? sum / total : 0
}

/**
 * Weighted share (0..1) of chord notes the instrument can play, every chord counted by its
 * weight (seconds). `shift` transposes the chords first. Null when there are no real chords.
 */
export function songCoverage(chords: readonly WeightedLabel[], scale: HandpanScale, shift = 0): number | null {
  const items = prepare(chords)
  return items.length ? coverageOf(items, scale.mask, shift) : null
}

export interface HandpanTranspose {
  /** semitones to add to the given chords (−range..+range); 0 = they already fit best */
  shift: number
  /** coverage after the shift */
  coverage: number
  /** coverage as given */
  current: number
}

/**
 * The transposition (−range..+range semitones) that makes the most chord notes playable.
 * Ties go to the smallest |shift| (downward first), so 0 wins whenever nothing is better.
 */
export function bestTransposeForHandpan(
  chords: readonly WeightedLabel[],
  scale: HandpanScale,
  range = 6,
): HandpanTranspose | null {
  const items = prepare(chords)
  if (!items.length) return null
  const current = coverageOf(items, scale.mask, 0)
  let best = { shift: 0, coverage: current }
  for (let d = 1; d <= range; d++) {
    for (const shift of [-d, d]) {
      const c = coverageOf(items, scale.mask, shift)
      if (c > best.coverage + 1e-9) best = { shift, coverage: c }
    }
  }
  return { ...best, current }
}
