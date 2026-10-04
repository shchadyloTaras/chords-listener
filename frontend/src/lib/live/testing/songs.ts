// Synthetic songs with known chords for the live analysis tests, the evaluation script and the
// dev harness (not used by the app). Rendered with the engine's test synthesizer.

import { renderProgression, rng, type ProgressionChord } from '../../engine/testing/synth.ts'

export interface TruthSegment {
  start: number
  end: number
  label: string
}

export interface SongSpec {
  name: string
  bpm: number
  beatsPerChord: number
  chords: string[]
  /** detuning in cents (all notes) */
  cents?: number
  /** white noise RMS relative to the song's peak (0 = none) */
  noise?: number
  leadIn?: number
  tail?: number
}

export interface RenderedSong {
  spec: SongSpec
  audio: Float32Array
  sampleRate: number
  duration: number
  /** chord changes (s) */
  changes: number[]
  /** ground truth, contiguous over [0, duration], "N" for the silent lead-in / tail */
  truth: TruthSegment[]
}

/** treble notes + bass (MIDI) of the chords used by the test songs */
export const VOICINGS: Record<string, ProgressionChord> = {
  C: { notes: [60, 64, 67], bass: 36 },
  G: { notes: [59, 62, 67], bass: 43 },
  Am: { notes: [57, 60, 64], bass: 45 },
  F: { notes: [57, 60, 65], bass: 41 },
  Dm: { notes: [57, 62, 65], bass: 38 },
  Em: { notes: [59, 64, 67], bass: 40 },
  E: { notes: [56, 59, 64], bass: 40 },
  B: { notes: [59, 63, 66], bass: 47 },
  'C#m': { notes: [56, 61, 64], bass: 37 },
  A: { notes: [57, 61, 64], bass: 45 },
  D: { notes: [57, 62, 66], bass: 38 },
  Bm: { notes: [59, 62, 66], bass: 47 },
  'F#m': { notes: [57, 61, 66], bass: 42 },
  Dm7: { notes: [57, 60, 62, 65], bass: 38 },
  G7: { notes: [59, 62, 65, 67], bass: 43 },
  Cmaj7: { notes: [59, 60, 64, 67], bass: 36 },
  Am7: { notes: [57, 60, 64, 67], bass: 45 },
}

export const SONGS: SongSpec[] = [
  { name: 'pop-120', bpm: 120, beatsPerChord: 4, chords: ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F'] },
  { name: 'sevenths-100', bpm: 100, beatsPerChord: 4, chords: ['Dm7', 'G7', 'Cmaj7', 'Am7', 'Dm7', 'G7', 'Cmaj7', 'Cmaj7'] },
  { name: 'fast-132', bpm: 132, beatsPerChord: 2, chords: ['E', 'B', 'C#m', 'A', 'E', 'B', 'C#m', 'A', 'E', 'B', 'A', 'E'] },
  { name: 'noisy-minor-96', bpm: 96, beatsPerChord: 4, chords: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E'], noise: 0.04 },
  { name: 'detuned-110', bpm: 110, beatsPerChord: 4, chords: ['D', 'Bm', 'G', 'A', 'D', 'F#m', 'G', 'A'], cents: 35 },
]

function transposeCents(c: ProgressionChord, cents: number): ProgressionChord {
  const f = cents / 100
  return { notes: c.notes.map((m) => m + f), bass: c.bass + f }
}

export function renderSong(spec: SongSpec, sampleRate: number): RenderedSong {
  const leadIn = spec.leadIn ?? 1
  const tail = spec.tail ?? 1
  const chords = spec.chords.map((label) => {
    const v = VOICINGS[label]
    if (!v) throw new Error(`no voicing for ${label}`)
    return spec.cents ? transposeCents(v, spec.cents) : v
  })
  const song = renderProgression(chords, { sr: sampleRate, bpm: spec.bpm, beatsPerChord: spec.beatsPerChord, leadIn, tail })
  const audio = song.audio
  if (spec.noise) {
    const r = rng(17)
    // uniform noise with the requested RMS, over the whole clip (lead-in and tail too)
    const amp = spec.noise * Math.sqrt(3)
    for (let i = 0; i < audio.length; i++) audio[i] += amp * (2 * r() - 1)
  }
  const chordLen = (60 / spec.bpm) * spec.beatsPerChord
  const truth: TruthSegment[] = [{ start: 0, end: song.changes[0], label: 'N' }]
  spec.chords.forEach((label, i) => {
    const start = song.changes[i]
    const prev = truth[truth.length - 1]
    if (prev.label === label) prev.end = start + chordLen
    else truth.push({ start, end: start + chordLen, label })
  })
  truth.push({ start: truth[truth.length - 1].end, end: song.duration, label: 'N' })
  return { spec, audio, sampleRate, duration: song.duration, changes: song.changes, truth }
}

export function labelAt(segments: readonly { start: number; end: number; label: string }[], t: number): string {
  for (const s of segments) if (s.start <= t && t < s.end) return s.label
  return 'N'
}

/**
 * Share of time (10 ms grid over [from, to)) where both label lists agree, optionally ignoring
 * `guard` seconds around the reference's chord changes.
 */
export function agreement(
  est: readonly { start: number; end: number; label: string }[],
  ref: readonly { start: number; end: number; label: string }[],
  from: number,
  to: number,
  guard = 0,
): number {
  const changes = ref.slice(1).map((s) => s.start)
  let hit = 0
  let n = 0
  for (let t = from; t < to; t += 0.01) {
    if (guard > 0 && changes.some((c) => Math.abs(c - t) < guard)) continue
    n++
    if (labelAt(est, t) === labelAt(ref, t)) hit++
  }
  return n ? hit / n : 1
}
