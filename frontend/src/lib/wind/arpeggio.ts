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

/** How much a chord tone matters when one has to go: root, third / sus note, 7th / 6th, 9th, fifth. */
function rank(interval: number): number {
  if (interval === 0) return 0
  if (interval <= 5) return 1
  if (interval >= 9 && interval <= 11) return 2
  if (interval >= 12) return 3
  return 4
}

/**
 * The line a chord is played as: its first pitch class and each note's distance above the first
 * (semitones), rising. Root, third (or the sus note), fifth, then the seventh / sixth / ninth; a
 * triad closes on the root an octave up, a chord with five notes leaves out its fifth (as players
 * do). A slash bass starts the line and the chord's other notes follow in close position above it,
 * the least important left out past four (C/E: E G C E, Am/G: G A C E, Cadd9/E: E G C D).
 */
export function arpeggioLine(label: string): { first: number; steps: number[]; bassFirst: boolean } | null {
  const p = parseChord(label)
  if (!p) return null
  const all = QUALITY_INTERVALS[p.quality]
  if (p.bassPc == null || p.bassPc === p.rootPc) {
    const steps = all.length > MAX_ARPEGGIO ? all.filter((i) => rank(i) < 4) : [...all]
    if (steps.length < MAX_ARPEGGIO) steps.push(12)
    return { first: p.rootPc, steps: steps.slice(0, MAX_ARPEGGIO), bassFirst: false }
  }
  const bass = p.bassPc
  const others = [...all]
    .sort((a, b) => rank(a) - rank(b))
    .map((i) => mod12(p.rootPc + i))
    .filter((pc, i, pcs) => pc !== bass && pcs.indexOf(pc) === i)
    .slice(0, MAX_ARPEGGIO - 1)
  const steps = [0, ...others.map((pc) => mod12(pc - bass)).sort((a, b) => a - b)]
  if (steps.length < MAX_ARPEGGIO) steps.push(12)
  return { first: bass, steps, bassFirst: true }
}

/**
 * The chord's arpeggio on the instrument: the first note the lowest of its pitch class at or above
 * the spec's startLow, the line rising from it — moved down an octave when it would run past the top
 * of the range, else its highest notes folded down an octave into the line. Empty for "N" / unknown
 * labels.
 */
export function windArpeggio(spec: WindSpec, label: string): WindNote[] {
  const p = parseChord(label)
  const line = arpeggioLine(label)
  if (!p || !line) return []
  const { low, high } = windRange(spec)
  const start = spec.startLow + mod12(line.first - spec.startLow)
  let midis = line.steps.map((s) => start + s)
  if (midis[midis.length - 1] > high && midis[0] - 12 >= low) midis = midis.map((m) => m - 12)
  midis = [...new Set(midis.map((m) => (m > high ? m - 12 * Math.ceil((m - high) / 12) : m)))]
    .filter((m) => m >= low && spec.fingerings[m] != null)
    .sort((a, b) => a - b)
  const spelled = spellNotes(p, midis)
  return midis.map((midi, i) => ({
    midi,
    name: spelled[i].name,
    octave: spelled[i].octave,
    role: i === 0 && line.bassFirst ? 'bass' : mod12(midi) === p.rootPc ? 'root' : 'tone',
    register: windRegister(spec, midi),
    cover: parseCover(spec.fingerings[midi]),
  }))
}
