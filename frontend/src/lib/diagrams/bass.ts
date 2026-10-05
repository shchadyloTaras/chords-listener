// Bass-guitar chord shapes, generated (chords-db has no bass): 4 strings E1 A1 D2 G2. A shape holds
// every chord tone in one hand position — the bass (slash bass, else root) lowest on the E or A
// string, then one chord tone or a muted string per higher string, rising in pitch — the arpeggio
// pattern a bassist plays across the strings. Pure; shapes come out in the chords-db Voicing format.

import type { ChordQuality } from '../../types'
import { formatChord, QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { mod12 } from '../music/notes'
import type { Voicing, VoicingLookup } from './chordsDb'

/** Open strings, low → high (MIDI): E1 A1 D2 G2. */
export const BASS_TUNING: readonly number[] = [28, 33, 38, 43]
const MAX_FRET = 12
/** Fretted notes of one shape lie within this many frets (one hand position). */
const SPAN = 4
const MAX_SHAPES = 6
/** Qualities whose fifth is perfect: it may be left out when the strings run out. */
const PERFECT_FIFTH: ReadonlySet<ChordQuality> = new Set<ChordQuality>([
  'maj', 'min', '7', 'maj7', 'min7', 'sus2', 'sus4', '6', 'min6', '9', 'add9',
])

interface Candidate {
  /** absolute fret per string, −1 muted */
  frets: number[]
  bassString: number
  /** required tones it holds */
  covered: number
  complete: boolean
}

/** Lowest fretted fret (open strings ignored); 0 when nothing is fretted. */
function position(frets: readonly number[]): number {
  const fretted = frets.filter((f) => f > 0)
  return fretted.length ? Math.min(...fretted) : 0
}

function span(frets: readonly number[]): number {
  const fretted = frets.filter((f) => f > 0)
  return fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0
}

/** Muted strings above the bass string. */
function mutes(c: Candidate): number {
  return c.frets.slice(c.bassString + 1).filter((f) => f < 0).length
}

/** Lower position, then fewer muted strings, bass on E before A, a smaller span, lower frets. */
function compare(a: Candidate, b: Candidate): number {
  const sum = (c: Candidate) => c.frets.reduce((s, f) => s + Math.max(0, f), 0)
  return (
    position(a.frets) - position(b.frets) ||
    mutes(a) - mutes(b) ||
    a.bassString - b.bassString ||
    span(a.frets) - span(b.frets) ||
    sum(a) - sum(b)
  )
}

/** Pitch classes of the chord itself (without a slash bass). */
function chordTones(chord: ParsedChord): number[] {
  return QUALITY_INTERVALS[chord.quality].map((i) => mod12(chord.rootPc + i))
}

/**
 * The tones a shape must hold with its bass on `bassString`. A perfect fifth (not the bass) is left
 * out when the tones outnumber the strings, or always with `dropFifth`.
 */
function requiredTones(chord: ParsedChord, bassString: number, dropFifth: boolean): Set<number> {
  const bassPc = chord.bassPc ?? chord.rootPc
  const tones = new Set([bassPc, ...chordTones(chord)])
  const room = BASS_TUNING.length - bassString
  const fifth = mod12(chord.rootPc + 7)
  if ((dropFifth || tones.size > room) && PERFECT_FIFTH.has(chord.quality) && fifth !== bassPc) tones.delete(fifth)
  return tones
}

/** Every shape with the bass at `bassFret` on `bassString` (strings above: a chord tone or muted). */
function shapesFrom(chord: ParsedChord, bassString: number, bassFret: number, dropFifth: boolean, out: Candidate[]): void {
  const required = requiredTones(chord, bassString, dropFifth)
  const allowed = new Set([...required, ...chordTones(chord)])
  const frets = BASS_TUNING.map(() => -1)
  frets[bassString] = bassFret
  const walk = (s: number, last: number, lo: number, hi: number, held: ReadonlySet<number>) => {
    if (s === BASS_TUNING.length) {
      let covered = 0
      for (const pc of required) if (held.has(pc)) covered++
      out.push({ frets: [...frets], bassString, covered, complete: covered === required.size })
      return
    }
    frets[s] = -1
    walk(s + 1, last, lo, hi, held)
    for (let f = 0; f <= MAX_FRET; f++) {
      const midi = BASS_TUNING[s] + f
      if (midi <= last || !allowed.has(mod12(midi))) continue
      const nlo = f > 0 ? Math.min(lo, f) : lo
      const nhi = f > 0 ? Math.max(hi, f) : hi
      if (nhi - nlo > SPAN - 1) continue
      frets[s] = f
      walk(s + 1, midi, nlo, nhi, new Set(held).add(mod12(midi)))
    }
    frets[s] = -1
  }
  const bassMidi = BASS_TUNING[bassString] + bassFret
  walk(bassString + 1, bassMidi, bassFret > 0 ? bassFret : Infinity, bassFret > 0 ? bassFret : -Infinity, new Set([mod12(bassMidi)]))
}

function candidates(chord: ParsedChord, dropFifth: boolean): Candidate[] {
  const bassPc = chord.bassPc ?? chord.rootPc
  const out: Candidate[] = []
  for (let bassString = 0; bassString < 2; bassString++) {
    for (let fret = 0; fret <= MAX_FRET; fret++) {
      if (mod12(BASS_TUNING[bassString] + fret) === bassPc) shapesFrom(chord, bassString, fret, dropFifth, out)
    }
  }
  return out
}

/** A candidate in the chords-db format: frets relative to baseFret, fingers by fret, MIDI notes. */
function toVoicing(frets: readonly number[]): Voicing {
  const fretted = frets.filter((f) => f > 0)
  const min = fretted.length ? Math.min(...fretted) : 1
  const baseFret = Math.max(...frets) <= SPAN ? 1 : min
  return {
    frets: frets.map((f) => (f <= 0 ? f : f - baseFret + 1)),
    fingers: frets.map((f) => (f > 0 ? f - min + 1 : 0)),
    baseFret,
    barres: [],
    midi: frets.flatMap((f, s) => (f >= 0 ? [BASS_TUNING[s] + f] : [])),
  }
}

/**
 * Shapes for a chord on the bass, lowest position first (at most one per bass-note position, up to
 * six). Without a shape holding every tone the perfect fifth may go; without one even then, the
 * shapes holding the most tones (exact: false).
 */
export function bassVoicings(chord: ParsedChord): VoicingLookup {
  const all = candidates(chord, false)
  let complete = all.filter((c) => c.complete)
  if (!complete.length) complete = candidates(chord, true).filter((c) => c.complete)
  const best = Math.max(0, ...all.map((c) => c.covered))
  const pool = complete.length ? complete : all.filter((c) => c.covered === best)
  // the best shape per bass position, then the positions in order
  const byBass = new Map<string, Candidate>()
  for (const c of pool) {
    const key = `${c.bassString}:${c.frets[c.bassString]}`
    const have = byBass.get(key)
    if (!have || compare(c, have) < 0) byBass.set(key, c)
  }
  const shapes = [...byBass.values()].sort(compare).slice(0, MAX_SHAPES)
  return {
    voicings: shapes.map((c) => toVoicing(c.frets)),
    strings: BASS_TUNING.length,
    exact: complete.length > 0,
    shown: formatChord(chord),
  }
}
