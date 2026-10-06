// Test fixtures: bars built by the app's own bar grid (lib/music/bars) from a beat list, with chords
// from the display pipeline, plus a short song (vocal melody + accompaniment) with known notes.

import type { ChordSegment } from '../../../types'
import { buildBarGrid, fillBars, type Bar } from '../../music/bars'
import { buildDisplayChords } from '../../music/display'
import type { Spelling } from '../../music/notes'
import type { NoteRow } from '../vocal'

export interface SteadySong {
  bpm: number
  /** beats per bar */
  ts?: number
  bars: number
  /** first downbeat (s) */
  offset?: number
  /** beats of audio after the last full bar (the song ends inside a new bar) */
  tail?: number
  /** [label, start beat, beats] counted from the first downbeat */
  chords?: [string, number, number][]
  transpose?: number
  spelling?: Spelling
  /** per-beat jitter (s) to make the tempo uneven */
  jitter?: (i: number) => number
}

export function steadyBars(s: SteadySong): { bars: Bar[]; beats: number[]; duration: number; beat: number } {
  const ts = s.ts ?? 4
  const beat = 60 / s.bpm
  const offset = s.offset ?? 0
  const n = s.bars * ts + (s.tail ?? 0)
  // beats before the first downbeat too (a pickup)
  const lead = Math.floor(offset / beat + 1e-9)
  const beats: number[] = []
  for (let i = -lead; i < n; i++) beats.push(offset + i * beat + (s.jitter?.(i) ?? 0))
  const downbeats = beats.filter((_, i) => (i - lead) % ts === 0 && i >= lead)
  const duration = offset + n * beat
  const frames = buildBarGrid({ duration, beats, downbeats, tempo: s.bpm, timeSignature: ts })
  const segs: ChordSegment[] = (s.chords ?? []).map(([label, b0, len]) => ({
    start: offset + b0 * beat,
    end: offset + (b0 + len) * beat,
    label,
    root: null,
    quality: null,
    confidence: 0.9,
  }))
  if (segs.length && segs[0].start > 0) segs.unshift({ start: 0, end: segs[0].start, label: 'N', root: null, quality: null, confidence: 1 })
  const display = buildDisplayChords(segs, { transpose: s.transpose ?? 0, simplify: false, spelling: s.spelling ?? 'sharp' })
  return { bars: fillBars(frames, display), beats, duration, beat }
}

/**
 * Four bars of 4/4 at 100 BPM (beat 0.6 s) in A minor: Am | F | C | G, a sung melody (with a pickup
 * note, a syncopation, a held note across the barline) and a piano part (bass + chords).
 */
export function demoSong() {
  const bpm = 100
  const b = 60 / bpm
  const song = steadyBars({ bpm, bars: 4, chords: [['Am', 0, 4], ['F', 4, 4], ['C', 8, 4], ['G', 12, 4]] })
  const t = (beat: number) => beat * b
  // vocal (sung slightly off the grid, like a real singer)
  const vocals: NoteRow[] = [
    [t(0) + 0.02, t(1) - 0.03, 69, 0.8], // A4 quarter
    [t(1) + 0.01, t(1.5) - 0.02, 72, 0.7], // C5 eighth
    [t(1.5) - 0.02, t(2.5) + 0.01, 71, 0.75], // B4 syncopated quarter
    [t(2.5), t(4) - 0.05, 69, 0.8], // A4 dotted quarter
    [t(4.02), t(6), 65, 0.7], // F4 half
    [t(6) + 0.03, t(8) + t(1) - 0.04, 64, 0.8], // E4 tied over the barline (half + quarter)
    [t(9) + 0.01, t(9.75), 67, 0.6], // G4 dotted eighth
    [t(9.75), t(10), 69, 0.6], // A4 sixteenth
    [t(10), t(12), 72, 0.9], // C5 half
    [t(12), t(15), 71, 0.8], // B4 dotted half
  ]
  const chord = (beat: number, len: number, midis: number[], v = 0.8): NoteRow[] => midis.map((m) => [t(beat) + 0.004, t(beat + len) - 0.02, m, v])
  const piano: NoteRow[] = [
    ...chord(0, 4, [45], 0.9), // A2
    ...chord(0, 2, [57, 60, 64]),
    ...chord(2, 2, [57, 60, 64]),
    ...chord(4, 4, [41], 0.9), // F2
    ...chord(4, 2, [57, 60, 65]),
    ...chord(6, 2, [57, 60, 65]),
    ...chord(8, 4, [48], 0.9), // C3
    ...chord(8, 1, [55, 60, 64]),
    ...chord(9, 1, [55, 60, 64]),
    ...chord(10, 1, [55, 60, 64]),
    ...chord(11, 1, [55, 60, 64]),
    ...chord(12, 4, [43], 0.9), // G2
    ...chord(12, 4, [55, 59, 62, 67]),
  ]
  return { ...song, vocals, piano }
}
