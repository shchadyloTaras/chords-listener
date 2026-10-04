// The in-browser analysis pipeline (pure functions on Float32Array; runs in the worker
// and in Node for evaluation). Modelled on the backend's DSP recognizer:
//   tuning -> log-frequency spectrum -> NNLS treble/bass chroma -> template HMM
//   (12 roots x 9 qualities + N, priors favouring plain triads, beat-aware change costs)
//   -> snap to beats / absorb short segments / slash basses -> meter, key, waveform.

import type { ChordSegment } from '../../../types'
import {
  ENGINE_QUALITIES, NO_CHORD, QUALITIES, QUALITY_PRIORS, bernoulliScores, chordFields, chordTemplates,
  chromaProbabilities, sameChord, type Chord, type EngineQuality,
} from './chords.ts'
import { posteriorsSticky, viterbiSticky } from './hmm.ts'
import { detectKey } from './key.ts'
import { resample } from './resample.ts'
import { chooseMeter, estimateTempo, onsetEnvelope, tempoFromBeats, trackBeats } from './rhythm.ts'
import {
  absorbShort, changePenalties, framesIn, mergeEqual, pathToSegments, snapBoundaries, type Segment,
} from './segments.ts'
import { SR, chromaFeatures, estimateTuning, type ChromaFeatures } from './spectrum.ts'
import type { BrowserAnalysis, BrowserProgress } from './types.ts'
import { percentile, round } from './util.ts'
import { frameRmsDb, waveformPeaks } from './waveform.ts'

export const ENGINE_NAME = 'chords-listener-web'
export const ENGINE_VERSION = '1.0.0'
export const ENGINE_LABEL = `${ENGINE_NAME} ${ENGINE_VERSION}`
/** analysis sample rate */
export const ANALYSIS_RATE = SR

/** anything shorter (s) is reported as a single "N" segment */
const MIN_DURATION = 0.5
/** richer labels are less certain than the maj/min class */
const EXTENDED_CONFIDENCE = 0.85

export interface AnalyzeParams {
  /** extra log-cost of a chord change away from a beat / at an off-beat */
  offBeatPenalty: number
  halfBeatPenalty: number
  /** log-cost of any chord change (HMM self-transition preference) */
  changePenalty: number
  /** weight of the bass-chroma root evidence */
  bassWeight: number
  /** "N" scores this much below the best chord (it wins on silence and when nothing fits) */
  noChordMargin: number
  /** chord boundaries within this many seconds of a beat move onto it */
  snapTolerance: number
  /** segments shorter than this many beats are absorbed by a neighbour */
  minSegmentBeats: number
  /** frames quieter than max(this, loud level - 45 dB) are silent */
  silenceDb: number
  // slash chords: the bass pitch must dominate the bass register for a while
  slashMinBeats: number
  slashRatio: number
  slashRatioFifth: number
  slashMinShare: number
}

export const DEFAULT_PARAMS: Readonly<AnalyzeParams> = {
  offBeatPenalty: 3.0,
  halfBeatPenalty: 1.5,
  changePenalty: 9.0,
  bassWeight: 0.6,
  noChordMargin: 4.0,
  snapTolerance: 0.16,
  minSegmentBeats: 0.9,
  silenceDb: -50,
  slashMinBeats: 1.5,
  slashRatio: 1.8,
  slashRatioFifth: 2.6,
  slashMinShare: 0.34,
}

export interface AnalyzeOptions {
  /** exact duration of the decoded audio (s); defaults to samples / sampleRate */
  duration?: number
  onProgress?: BrowserProgress
  params?: Partial<AnalyzeParams>
}

interface Beats {
  beats: number[]
  tempo: number
  /** inter-beat interval (s) */
  ibi: number
}

function monotonic(fn?: BrowserProgress): BrowserProgress {
  let last = 0
  return (fraction, message) => {
    last = Math.min(1, Math.max(last, fraction))
    fn?.(last, message)
  }
}

/** Analyze mono audio at any sample rate. See docs/SPEC.md for the result shape. */
export function analyzeSignal(input: Float32Array, sampleRate: number, options: AnalyzeOptions = {}): BrowserAnalysis {
  const params: AnalyzeParams = { ...DEFAULT_PARAMS, ...options.params }
  const progress = monotonic(options.onProgress)
  const duration = options.duration ?? input.length / sampleRate
  progress(0, 'Preparing audio')
  let samples = input
  let peak = 0
  let finite = true
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
    else if (!(v <= peak)) finite = false // NaN / Infinity
  }
  if (!finite || !Number.isFinite(peak)) {
    samples = samples.map((v) => (Number.isFinite(v) ? v : 0))
    peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  }
  if (!(duration >= MIN_DURATION) || !(peak >= 1e-4)) {
    progress(1, 'Done')
    return trivialResult(samples, Number.isFinite(duration) ? duration : 0)
  }
  const y = sampleRate === SR ? samples : resample(samples, sampleRate, SR)

  progress(0.02, 'Estimating tuning')
  const tuning = estimateTuning(y)
  progress(0.05, 'Computing chroma')
  const chroma = chromaFeatures(y, tuning, (f) => progress(0.05 + 0.6 * f, 'Computing chroma'))

  progress(0.66, 'Tracking beats')
  const rhythm = trackRhythm(y)

  progress(0.78, 'Decoding chords')
  const silent = silentFrames(frameRmsDb(y, SR, chroma.fps, chroma.T), params.silenceDb)
  const segs = decodeChords(chroma, silent, rhythm, duration, params)

  progress(0.88, 'Refining chords')
  const chords = refineSegments(segs, chroma, rhythm, params)
  let downbeats = rhythm.beats.filter((_, i) => i % 4 === 0)
  let timeSignature = 4
  if (rhythm.beats.length >= 4) {
    const meter = chooseMeter(rhythm.beats, chords.slice(1).map((c) => c.start))
    downbeats = meter.downbeats
    timeSignature = meter.meter
  }

  progress(0.94, 'Detecting key')
  const key = detectKey(chords.map((c) => [c.chord, c.end - c.start] as [Chord, number]), voicedMean(chroma, silent))

  const result = assemble({
    duration,
    tempo: rhythm.tempo,
    timeSignature,
    beats: rhythm.beats,
    downbeats,
    chords,
    key,
    waveform: waveformPeaks(samples),
  })
  progress(1, 'Done')
  return result
}

function trivialResult(samples: Float32Array, duration: number): BrowserAnalysis {
  const d = round(Math.max(0, duration), 3)
  return {
    duration: d,
    tempo: 120,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: d > 0 ? [{ start: 0, end: d, label: 'N', root: null, quality: null, bass: null, confidence: 1 }] : [],
    key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0 },
    waveform: waveformPeaks(samples),
    engine: ENGINE_LABEL,
  }
}

function trackRhythm(y: Float32Array): Beats {
  const env = onsetEnvelope(y)
  const bpm = estimateTempo(env)
  const beats = bpm > 0 ? trackBeats(env, bpm) : []
  const tempo = tempoFromBeats(beats) || bpm
  return { beats, tempo, ibi: tempo > 0 ? 60 / tempo : 0.5 }
}

function silentFrames(rmsDb: Float64Array, floorDb: number): Uint8Array {
  const out = new Uint8Array(rmsDb.length)
  if (rmsDb.length === 0) return out
  const thr = Math.max(floorDb, percentile(rmsDb, 95) - 45)
  for (let t = 0; t < rmsDb.length; t++) out[t] = rmsDb[t] < thr ? 1 : 0
  return out
}

function voicedMean(chroma: ChromaFeatures, silent: Uint8Array): Float64Array | null {
  const m = new Float64Array(12)
  let n = 0
  for (let pass = 0; pass < 2 && n === 0; pass++) {
    for (let t = 0; t < chroma.T; t++) {
      if (pass === 0 && silent[t]) continue
      for (let i = 0; i < 12; i++) m[i] += chroma.treble[t * 12 + i]
      n++
    }
  }
  if (n === 0) return null
  for (let i = 0; i < 12; i++) m[i] /= n
  return m
}

// ---------------------------------------------------------------------------------------
// chord decoding

interface Vocabulary {
  chords: Chord[]
  templates: Uint8Array
  priors: Float64Array
}

let vocabulary: Vocabulary | null = null

function getVocabulary(): Vocabulary {
  if (vocabulary) return vocabulary
  const chords: Chord[] = []
  for (const q of ENGINE_QUALITIES) for (let r = 0; r < 12; r++) chords.push({ root: r, quality: q, bass: null })
  vocabulary = {
    chords,
    templates: chordTemplates(chords),
    priors: Float64Array.from(chords, (c) => QUALITY_PRIORS[c.quality as EngineQuality]),
  }
  return vocabulary
}

function decodeChords(chroma: ChromaFeatures, silent: Uint8Array, rhythm: Beats, duration: number,
  params: AnalyzeParams): { segs: Segment[]; vocab: Vocabulary; noChord: number } {
  const { T, fps } = chroma
  const vocab = getVocabulary()
  const V = vocab.chords.length
  const K = V + 1 // + N
  const U = new Float32Array(T * K)
  bernoulliScores(chromaProbabilities(chroma.treble, T), T, vocab.templates, V, U, K)
  const bassLog = new Float64Array(12)
  for (let t = 0; t < T; t++) {
    let tot = 0
    for (let i = 0; i < 12; i++) tot += chroma.bass[t * 12 + i]
    tot = Math.max(tot, 1e-9)
    for (let i = 0; i < 12; i++) bassLog[i] = params.bassWeight * Math.log(chroma.bass[t * 12 + i] / tot + 0.08)
    let best = -Infinity
    for (let k = 0; k < V; k++) {
      const v = U[t * K + k] + vocab.priors[k] + bassLog[vocab.chords[k].root!]
      U[t * K + k] = v
      if (v > best) best = v
    }
    U[t * K + V] = best - params.noChordMargin + (silent[t] ? 30 : 0)
  }
  const pen = changePenalties(T, fps, rhythm.beats, params.offBeatPenalty, params.halfBeatPenalty)
  const path = viterbiSticky(U, T, K, params.changePenalty, pen)
  const post = posteriorsSticky(U, T, K, params.changePenalty, pen)

  const score = (seg: Segment, state: number): number => {
    const b = Math.max(seg.last, seg.first + 1)
    let s = 0
    for (let t = seg.first; t < b; t++) s += post[t * K + state]
    return s / (b - seg.first)
  }
  let segs = pathToSegments(path, fps, duration)
  segs = snapBoundaries(segs, rhythm.beats, params.snapTolerance)
  segs = mergeEqual(segs)
  const minDur = params.minSegmentBeats * (rhythm.beats.length >= 2 ? rhythm.ibi : 0.5)
  segs = absorbShort(segs, minDur, score)
  segs = mergeEqual(segs)
  for (const s of segs) s.confidence = score(s, s.state)
  return { segs, vocab, noChord: V }
}

// ---------------------------------------------------------------------------------------
// refinement: slash basses (and the bass-named root of symmetric augmented chords)

interface RefinedChord {
  start: number
  end: number
  chord: Chord
  confidence: number
}

function bassShare(chroma: ChromaFeatures, a: number, b: number): Float64Array | null {
  const [lo, hi] = framesIn(chroma.T, chroma.fps, a, b)
  const m = new Float64Array(12)
  for (let t = lo; t < hi; t++) for (let i = 0; i < 12; i++) m[i] += chroma.bass[t * 12 + i]
  let tot = 0
  for (let i = 0; i < 12; i++) tot += m[i]
  if (tot <= 1e-9) return null
  for (let i = 0; i < 12; i++) m[i] /= tot
  return m
}

function detectBass(share: Float64Array | null, root: number, quality: string, beatsLen: number,
  params: AnalyzeParams): number | null {
  if (beatsLen < params.slashMinBeats || !share) return null
  let pc = 0
  for (let i = 1; i < 12; i++) if (share[i] > share[pc]) pc = i
  if (pc === root) return null
  const rel = (pc - root + 12) % 12
  const allowed = new Set(QUALITIES[quality].intervals.slice(1))
  if (quality === 'maj' || quality === 'min') allowed.add(10) // e.g. C/A#, Am/G descending bass lines
  if (!allowed.has(rel)) return null
  const ratio = rel === 7 ? params.slashRatioFifth : params.slashRatio
  if (share[pc] < params.slashMinShare || share[pc] < ratio * share[root]) return null
  return pc
}

function refineSegments(decoded: { segs: Segment[]; vocab: Vocabulary; noChord: number }, chroma: ChromaFeatures,
  rhythm: Beats, params: AnalyzeParams): RefinedChord[] {
  const ibi = rhythm.beats.length >= 2 ? rhythm.ibi : 0.5
  const out: RefinedChord[] = []
  for (const seg of decoded.segs) {
    let chord: Chord = NO_CHORD
    let conf = seg.confidence
    if (seg.state !== decoded.noChord) {
      const coarse = decoded.vocab.chords[seg.state]
      let root = coarse.root!
      const quality = coarse.quality!
      const share = bassShare(chroma, seg.start, seg.end)
      if (quality === 'aug' && share) {
        // symmetric chord: name it after the bass
        const opts = [root, (root + 4) % 12, (root + 8) % 12]
        const best = opts.reduce((a, b) => (share[b] > share[a] ? b : a))
        if (share[best] > 1.5 * share[root]) root = best
      }
      const bass = detectBass(share, root, quality, (seg.end - seg.start) / ibi, params)
      chord = { root, quality, bass }
      if ((quality !== 'maj' && quality !== 'min') || bass !== null) conf *= EXTENDED_CONFIDENCE
    }
    const prev = out[out.length - 1]
    if (prev && sameChord(prev.chord, chord)) {
      const w0 = prev.end - prev.start
      const w1 = seg.end - seg.start
      prev.confidence = (prev.confidence * w0 + conf * w1) / Math.max(w0 + w1, 1e-9)
      prev.end = seg.end
    } else {
      out.push({ start: seg.start, end: seg.end, chord, confidence: conf })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// result

function assemble(r: {
  duration: number
  tempo: number
  timeSignature: number
  beats: number[]
  downbeats: number[]
  chords: RefinedChord[]
  key: BrowserAnalysis['key']
  waveform: number[]
}): BrowserAnalysis {
  const duration = round(r.duration, 3)
  let segs: ChordSegment[] = []
  for (const c of r.chords) {
    const s = Math.max(0, c.start)
    const e = Math.min(r.duration, c.end)
    if (e - s <= 1e-6) continue
    segs.push({
      start: round(s, 3),
      end: round(e, 3),
      ...chordFields(c.chord),
      confidence: round(Math.min(1, Math.max(0, c.confidence)), 3),
    })
  }
  if (segs.length === 0) {
    segs = [{ start: 0, end: duration, ...chordFields(NO_CHORD), confidence: 1 }]
  }
  // exact contiguity and coverage of [0, duration]
  segs[0].start = 0
  for (let i = 1; i < segs.length; i++) segs[i].start = segs[i - 1].end
  segs[segs.length - 1].end = duration
  segs = segs.filter((s) => s.end > s.start)
  if (segs.length === 0) segs = [{ start: 0, end: duration, ...chordFields(NO_CHORD), confidence: 1 }]
  const inRange = (t: number) => t >= 0 && t <= r.duration
  const beats = r.beats.filter(inRange).map((b) => round(b, 3))
  const tempo = r.tempo > 0 ? r.tempo : tempoFromBeats(beats)
  return {
    duration,
    tempo: tempo > 0 ? round(tempo, 2) : 120,
    timeSignature: r.timeSignature,
    beats,
    downbeats: r.downbeats.filter(inRange).map((b) => round(b, 3)),
    chords: segs,
    key: r.key,
    waveform: r.waveform,
    engine: ENGINE_LABEL,
  }
}
