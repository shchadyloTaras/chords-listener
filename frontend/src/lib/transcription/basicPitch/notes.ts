// Note events for the live piano from Basic Pitch activations: the reference decoder
// (postprocess.ts) tuned for a "pianist" display, plus exact frame timing, sub-frame onset
// refinement, de-duplication and a velocity from the note's amplitude.
import type { NoteEvent } from '../compact.ts'
import { FFT_HOP, MIDI_MAX, MIDI_MIN, N_PITCHES, SAMPLE_RATE } from './constants.ts'
import type { Posteriorgram } from './infer.ts'
import { outputToNotesPoly, type RawNote } from './postprocess.ts'
import { timeAt } from './windows.ts'

export type { NoteEvent }

export interface NoteParams {
  /** onset activation that starts a note */
  onsetThresh: number
  /** frame activation that keeps it sounding */
  frameThresh: number
  /** shortest note kept, ms */
  minNoteMs: number
  /** also keep sustained energy without a detected onset */
  melodiaTrick: boolean
  /** add onsets where the frame activation jumps (reference default: on) */
  inferOnsets: boolean
  energyTolerance: number
  midiMin: number
  midiMax: number
  /** a note without its own onset that starts this soon after the same pitch ended continues it, ms */
  sustainGapMs: number
  /**
   * A new note of a pitch that was sounding until (almost) its start is a re-strike only with a clear
   * attack: below this onset activation it is the same note continuing (harmonics of other notes
   * often re-trigger a held one).
   */
  reattackOnset: number
  /** notes weaker than this (½ amplitude + ½ attack) are dropped: mostly harmonic "ghost" notes */
  minStrength: number
  /**
   * Added to every onset (s): the model fires ~4 ms before the attack on average (measured with
   * scripts/eval-transcription.ts: −4.1 ms mean over 300 synthetic piano / plucked notes).
   */
  onsetShift: number
}

/** Tuned for a "pianist" display on synthetic piano / plucked music (scripts/eval-transcription.ts). */
export const PIANO_PARAMS: NoteParams = {
  onsetThresh: 0.5,
  frameThresh: 0.3,
  minNoteMs: 80,
  melodiaTrick: true,
  inferOnsets: true,
  energyTolerance: 11,
  midiMin: MIDI_MIN,
  midiMax: MIDI_MAX,
  sustainGapMs: 120,
  reattackOnset: 0.7,
  minStrength: 0.4,
  onsetShift: 0.004,
}

export const FRAME_SECONDS = FFT_HOP / SAMPLE_RATE

/** Frames a note needs to exceed so it lasts at least `ms` (reference `minNoteLen`: dropped when ≤). */
export function minNoteFrames(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000 / FRAME_SECONDS) - 1)
}

/** Parabolic interpolation of the onset peak around `row` (−0.5..0.5 frames), 0 when not a clean peak. */
export function refineOnset(onsets: Float32Array, nFrames: number, row: number, col: number): number {
  if (row <= 0 || row >= nFrames - 1) return 0
  const a = onsets[(row - 1) * N_PITCHES + col]
  const b = onsets[row * N_PITCHES + col]
  const c = onsets[(row + 1) * N_PITCHES + col]
  if (!(b >= a && b >= c)) return 0
  const den = a - 2 * b + c
  if (den >= 0) return 0
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
}

/** A decoded note before merging: `attack` = onset activation at its start (0: no onset). */
export interface DraftNote extends NoteEvent {
  attack: number
  /** ½ amplitude + ½ attack, 0..1 */
  strength: number
}

export interface MergeRules {
  /** s: an onset-less note this soon after the same pitch ended continues it */
  sustainGap: number
  /** s: a note starting this soon after the same pitch ended… */
  splitGap: number
  /** …continues it unless its attack reaches this */
  reattackOnset: number
}

/**
 * Removes duplicates per pitch: overlapping notes and double attacks become one note; a note that
 * starts right where the same pitch stopped without a real attack (or with none) continues it.
 */
export function mergeNotes<T extends DraftNote>(notes: T[], rules: MergeRules): T[] {
  const byPitch = new Map<number, T[]>()
  for (const n of notes) {
    const list = byPitch.get(n.midi)
    if (list) list.push(n)
    else byPitch.set(n.midi, [n])
  }
  const out: T[] = []
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.start - b.start || b.end - a.end)
    let cur: T | null = null
    for (const n of list) {
      if (cur) {
        const gap = n.start - cur.end
        const continues =
          gap < -0.001 || // overlapping duplicate
          n.start - cur.start < 0.035 || // the same attack twice
          (n.attack === 0 && gap <= rules.sustainGap) || // energy that kept sounding
          (gap <= rules.splitGap && n.attack < rules.reattackOnset) // re-triggered without a real attack
        if (continues) {
          cur.end = Math.max(cur.end, n.end)
          cur.velocity = Math.max(cur.velocity, n.velocity)
          cur.strength = Math.max(cur.strength, n.strength)
          continue
        }
        out.push(cur)
      }
      cur = { ...n }
    }
    if (cur) out.push(cur)
  }
  return out.sort((a, b) => a.start - b.start || a.midi - b.midi)
}

/** Onset activation around a start frame (max over ±2 frames: the peak may sit a frame off). */
function attackAt(onsets: Float32Array, nFrames: number, row: number, col: number): number {
  let v = 0
  for (let r = Math.max(0, row - 2); r <= Math.min(nFrames - 1, row + 2); r++) v = Math.max(v, onsets[r * N_PITCHES + col])
  return v
}

/** Decodes activations into sorted note events (times in seconds, rounded to 1 ms). */
export function posteriorgramToNotes(pg: Posteriorgram, params: Partial<NoteParams> = {}): NoteEvent[] {
  const p: NoteParams = { ...PIANO_PARAMS, ...params }
  const raw: RawNote[] = outputToNotesPoly(pg.frames, pg.onsets, pg.nFrames, {
    onsetThresh: p.onsetThresh,
    frameThresh: p.frameThresh,
    minNoteLen: minNoteFrames(p.minNoteMs),
    inferOnsets: p.inferOnsets,
    melodiaTrick: p.melodiaTrick,
    energyTolerance: p.energyTolerance,
  })
  const drafts: DraftNote[] = []
  const lastTime = pg.times.length ? pg.times[pg.times.length - 1] + FRAME_SECONDS : 0
  for (const r of raw) {
    if (r.pitchMidi < p.midiMin || r.pitchMidi > p.midiMax) continue
    const col = r.pitchMidi - MIDI_MIN
    const delta = r.fromOnset ? refineOnset(pg.onsets, pg.nFrames, r.startFrame, col) : 0
    const start = Math.max(0, timeAt(pg.times, r.startFrame + delta) + p.onsetShift)
    // active frames are [startFrame, startFrame + duration): it stops between the last active frame and the next
    const end = Math.min(lastTime, timeAt(pg.times, r.startFrame + r.durationFrames - 0.5))
    if (!(end > start)) continue
    const attack = r.fromOnset ? attackAt(pg.onsets, pg.nFrames, r.startFrame, col) : 0
    const strength = 0.5 * r.amplitude + 0.5 * (r.fromOnset ? attack : r.amplitude)
    drafts.push({ midi: r.pitchMidi, start, end, velocity: 0, attack, strength })
  }
  const merged = mergeNotes(drafts, {
    sustainGap: p.sustainGapMs / 1000,
    splitGap: 0.03,
    reattackOnset: p.reattackOnset,
  }).filter((n) => n.strength >= p.minStrength)
  // velocity: strength stretched over this song's dynamic range (loudest ~5 % → 1)
  const lo = p.frameThresh
  const hi = Math.max(lo + 0.25, percentile(merged.map((n) => n.strength), 0.95))
  return merged.map((n) => ({
    midi: n.midi,
    start: Math.round(n.start * 1000) / 1000,
    end: Math.round(n.end * 1000) / 1000,
    velocity: Math.round(Math.min(1, Math.max(0.1, (n.strength - lo) / (hi - lo))) * 1000) / 1000,
  }))
}
