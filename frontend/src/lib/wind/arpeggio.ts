// A chord on a one-voice instrument: the notes of its arpeggio, as a melody player outlines the
// harmony, each with the instrument's fingering. Pure.

import { spellNotes } from '../diagrams/staff'
import { parseChord, QUALITY_INTERVALS } from '../music/chord'
import { mod12 } from '../music/notes'
import type { Cover, WindNote, WindSpec } from './types'

/** The longest arpeggio a chart shows (and the chord sound plays). */
export const MAX_ARPEGGIO = 4

/** A fingering string as covers ("x" 1, "h" 0.5, "o" 0), spaces ignored. */
export function parseCover(fingering: string): Cover[] {
  return [...fingering.replace(/\s+/g, '')].map((c) => (c === 'x' ? 1 : c === 'h' ? 0.5 : 0))
}

/** Lowest and highest notes the instrument has a fingering for. */
export function windRange(spec: WindSpec): { low: number; high: number } {
  const midis = Object.keys(spec.fingerings).map(Number)
  return { low: Math.min(...midis), high: Math.max(...midis) }
}

/** 1 for the instrument's fundamental register, 2 from its first overblown note up, and so on. */
export function windRegister(spec: WindSpec, midi: number): number {
  return 1 + spec.registers.filter((r) => midi >= r).length
}

/**
 * Pitch classes in the order they are played, rising: root, third (or the sus note), fifth, then
 * the seventh / sixth / ninth; a triad closes on the root an octave up, a chord with five notes
 * leaves out its fifth (as players do). A slash bass starts the line: a chord tone in the bass turns
 * it into an inversion (C/E: E G C E), any other bass note goes under the root (Am/G: G A C E).
 */
export function arpeggioClasses(label: string): { pcs: number[]; bassFirst: boolean } | null {
  const p = parseChord(label)
  if (!p) return null
  let intervals = [...QUALITY_INTERVALS[p.quality]]
  if (intervals.length > MAX_ARPEGGIO) intervals = intervals.filter((i) => i !== 7)
  const chord = intervals.map((i) => mod12(p.rootPc + i))
  if (p.bassPc == null || p.bassPc === p.rootPc) {
    if (chord.length < MAX_ARPEGGIO) chord.push(chord[0])
    return { pcs: chord.slice(0, MAX_ARPEGGIO), bassFirst: false }
  }
  const at = chord.indexOf(p.bassPc)
  if (at >= 0) {
    const inversion = [...chord.slice(at), ...chord.slice(0, at)]
    if (inversion.length < MAX_ARPEGGIO) inversion.push(inversion[0])
    return { pcs: inversion.slice(0, MAX_ARPEGGIO), bassFirst: true }
  }
  return { pcs: [p.bassPc, ...chord].slice(0, MAX_ARPEGGIO), bassFirst: true }
}

/**
 * The chord's arpeggio on the instrument: the first note at or above the spec's startLow, each next
 * one the nearest above it — moved down an octave when it would run past the top of the range,
 * notes the instrument still cannot reach left out. Empty for "N" / unknown labels.
 */
export function windArpeggio(spec: WindSpec, label: string): WindNote[] {
  const p = parseChord(label)
  const order = arpeggioClasses(label)
  if (!p || !order) return []
  const { low, high } = windRange(spec)
  const midis: number[] = []
  for (const pc of order.pcs) {
    const prev = midis[midis.length - 1]
    const from = prev == null ? spec.startLow : prev + 1
    midis.push(from + mod12(pc - from))
  }
  if (midis[midis.length - 1] > high && midis[0] - 12 >= low) for (let i = 0; i < midis.length; i++) midis[i] -= 12
  const playable = midis.filter((m) => m >= low && m <= high && spec.fingerings[m] != null)
  const spelled = spellNotes(p, playable)
  return playable.map((midi, i) => ({
    midi,
    name: spelled[i].name,
    octave: spelled[i].octave,
    role: i === 0 && order.bassFirst ? 'bass' : mod12(midi) === p.rootPc ? 'root' : 'tone',
    register: windRegister(spec, midi),
    cover: parseCover(spec.fingerings[midi]),
  }))
}
