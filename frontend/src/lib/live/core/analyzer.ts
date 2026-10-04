// Live chord analysis core (pure, runs in the worker and in Node tests):
//   input PCM (any rate) -> 22.05 kHz -> streaming chroma -> the offline engine's chord scores
//   (same vocabulary, priors, bass weighting and "N" rule; plus flat-chroma noise -> "N") ->
//   online HMM (forward filter + fixed-lag smoothing + minimum-duration cleanup, beat-aware
//   change costs from a running beat tracker) -> chords with provisional / final state, plus a
//   running key, tempo, reference-pitch estimate and an input level for a meter.

import type { KeyInfo } from '../../../types'
import { DEFAULT_PARAMS, getVocabulary, type AnalyzeParams } from '../../engine/core/analyze.ts'
import { PITCH_NAMES, chordFields, type Chord } from '../../engine/core/chords.ts'
import { keyScores } from '../../engine/core/key.ts'
import { estimateTempo, onsetEnvelope, trackBeats } from '../../engine/core/rhythm.ts'
import { FPS, SR, estimateTuning } from '../../engine/core/spectrum.ts'
import { median, nearestDistance, percentile } from '../../engine/core/util.ts'
import { OnlineChordDecoder, type DecodedRun } from './decoder.ts'
import { StreamingChroma, type ChromaFrame } from './features.ts'
import { StreamingResampler } from './resampler.ts'
import { frameScores } from './scores.ts'

/** Same chord shape as the public LiveChord (src/lib/live/index.ts). */
export interface AnalyzerChord {
  start: number
  end: number
  label: string
  confidence: number
  provisional: boolean
}

export interface LiveAnalyzerOptions {
  /** sample rate of the pushed audio */
  inputRate: number
  /** fixed-lag smoothing delay in frames (1 frame = 2048 / 22050 s ≈ 93 ms; default DEFAULT_LAG) */
  lag?: number
  /** center the bass window this many frames earlier (lower latency, see StreamingChroma; default DEFAULT_BASS_LAG) */
  bassLag?: number
  /** fixed reference pitch (semitones); default: estimated from the audio while listening */
  tuning?: number
  /** a new current chord is shown once it has won this many frames in a row (default DEFAULT_HOLD) */
  hold?: number
  /** overrides of the engine parameters (defaults: the offline DEFAULT_PARAMS + LIVE_PARAMS) */
  params?: Partial<AnalyzeParams>
  /** running tempo estimate (default true) */
  tempo?: boolean
  /** beat tracking: chord changes cost more away from the beat, like offline (default true; needs `tempo`) */
  beats?: boolean
}

export interface LiveAnalysisState {
  /** seconds of input analyzed */
  time: number
  /** chords that became final since the previous call, oldest first */
  finalized: AnalyzerChord[]
  /** chords after the final ones (provisional or open), oldest first; the last one is the current chord */
  open: AnalyzerChord[]
  /** input RMS since the previous call, 0..1 (-60..0 dBFS) */
  level: number
  key: KeyInfo | null
  tempo: number | null
  tuning: number
  /** seconds the chord frames trail the input (window look-ahead) */
  delay: number
}

/** smoothing lag (frames): 8 x 93 ms = 0.74 s */
export const DEFAULT_LAG = 8
/** bass window centered 2 hops earlier: frames are ready 0.37 s after their time instead of 0.56 s */
export const DEFAULT_BASS_LAG = 2
/** a new current chord must win 3 frames (~0.28 s of evidence, partly smoothed) before it is shown */
export const DEFAULT_HOLD = 3
/**
 * Live departures from the offline parameters: a slightly higher change cost, because the
 * running beat grid is less certain than the offline one (tuned on synthetic + real recordings).
 */
export const LIVE_PARAMS: Partial<AnalyzeParams> = { changePenalty: 10.5 }
const EXTENDED_CONFIDENCE = 0.85
/** quieter than this (dBFS) reads as 0 on the meter */
const METER_FLOOR_DB = -60
/** history kept for the tuning / tempo estimates (s) */
const HISTORY_SEC = 15
/** silence threshold window (s) */
const LOUDNESS_WINDOW_SEC = 60
const TUNING_AT = [3, 6, 10, 15]
const TUNING_EVERY = 15
const TEMPO_EVERY = 2
const TEMPO_WINDOW = 12
const TEMPO_MIN_SEC = 6
const KEY_EVERY = 1
const KEY_WINDOW = 90
/** voiced chord seconds before a key is reported */
const KEY_MIN_SEC = 8
/** evaluations a new key must win in a row before it replaces the shown one */
const KEY_SWITCH_AFTER = 3
const CHROMA_DECAY_SEC = 60
/**
 * Noise -> "N" (live only; the offline engine has no such rule): broadband noise has a flat
 * chroma (normalized entropy ~0.99) while music stays below ~0.95, so flat frames move the
 * "N" score up by as much as NOISE_BONUS.
 */
const NOISE_ENTROPY_LO = 0.95
const NOISE_ENTROPY_HI = 0.985
const NOISE_BONUS = 10

/** Normalized entropy (0..1) of a 12-bin chroma vector; 0 for silence. */
export function chromaEntropy(v: ArrayLike<number>): number {
  let tot = 0
  for (let i = 0; i < 12; i++) tot += v[i]
  if (!(tot > 1e-12)) return 0
  let h = 0
  for (let i = 0; i < 12; i++) {
    const p = v[i] / tot
    if (p > 0) h -= p * Math.log(p)
  }
  return h / Math.log(12)
}

function round(x: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

interface FinalRun {
  start: number
  end: number
  chord: Chord
}

export class LiveAnalyzer {
  readonly inputRate: number
  readonly params: AnalyzeParams
  private readonly resampler: StreamingResampler
  private readonly chroma: StreamingChroma
  private readonly decoder: OnlineChordDecoder
  private readonly vocab = getVocabulary()
  private readonly V: number
  private readonly K: number
  private readonly U: Float32Array
  private readonly bassLog = new Float64Array(12)
  private readonly autoTuning: boolean
  private readonly tempoOn: boolean
  private readonly beatsOn: boolean
  /** tracked beat times (s, analysis time), sorted, and the off-beats between them */
  private beatTimes: number[] = []
  private beatMids: number[] = []
  /** input samples received */
  private inputSamples = 0
  // level since the last state() call
  private levelSum = 0
  private levelN = 0
  // loudness of recent frames for the silence threshold
  private readonly loud: Float64Array
  private loudN = 0
  // recent 22.05 kHz audio for the tuning / tempo estimates (ring)
  private readonly hist: Float32Array
  private histN = 0
  private nextTuningAt = TUNING_AT[0]
  private tuningStep = 0
  private nextTempoAt = TEMPO_MIN_SEC
  private tempos: number[] = []
  private tempoValue: number | null = null
  /** final chords not yet returned by state() */
  private pendingFinal: AnalyzerChord[] = []
  // key
  private finals: FinalRun[] = []
  private chromaMean = new Float64Array(12)
  private chromaWeight = 0
  private nextKeyAt = KEY_EVERY
  private keyShown: KeyInfo | null = null
  private keyCandidate = -1
  private keyStreak = 0
  private ended = false

  constructor(options: LiveAnalyzerOptions) {
    this.inputRate = options.inputRate
    this.params = { ...DEFAULT_PARAMS, ...LIVE_PARAMS, ...options.params }
    this.resampler = new StreamingResampler(options.inputRate, SR)
    this.autoTuning = options.tuning === undefined
    this.tempoOn = options.tempo ?? true
    this.beatsOn = this.tempoOn && (options.beats ?? true)
    this.chroma = new StreamingChroma({ tuning: options.tuning ?? 0, bassLag: options.bassLag ?? DEFAULT_BASS_LAG })
    this.V = this.vocab.chords.length
    this.K = this.V + 1
    this.U = new Float32Array(this.K)
    this.decoder = new OnlineChordDecoder({
      K: this.K,
      lag: options.lag ?? DEFAULT_LAG,
      switchCost: this.params.changePenalty,
      minFrames: this.minFrames(null),
      hold: options.hold ?? DEFAULT_HOLD,
    })
    this.loud = new Float64Array(Math.round(LOUDNESS_WINDOW_SEC * FPS))
    this.hist = new Float32Array(Math.round(HISTORY_SEC * SR))
  }

  /** Seconds of input analyzed. */
  get time(): number {
    return this.inputSamples / this.inputRate
  }

  /** Seconds the chord frames trail the input. */
  get delay(): number {
    return this.chroma.delay
  }

  /** Feed mono input samples (at `inputRate`). */
  push(x: Float32Array): void {
    if (this.ended) return
    let s = 0
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      s += Number.isFinite(v) ? v * v : 0
    }
    this.levelSum += s
    this.levelN += x.length
    this.inputSamples += x.length
    const clean = x.every(Number.isFinite) ? x : x.map((v) => (Number.isFinite(v) ? v : 0))
    this.process(this.resampler.push(clean), false)
  }

  /** Current state; `finalized` holds only what became final since the previous call. */
  state(): LiveAnalysisState {
    const ms = this.levelN ? this.levelSum / this.levelN : 0
    this.levelSum = 0
    this.levelN = 0
    const db = 10 * Math.log10(ms + 1e-12)
    const level = Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
    const time = this.time
    const open = this.decoder.open().map((r) => this.toChord(r))
    const cur = open[open.length - 1]
    if (cur) cur.end = round(Math.max(cur.end, time), 3)
    return {
      time,
      finalized: this.takeFinal(),
      open,
      level: round(level, 3),
      key: this.keyShown,
      tempo: this.tempoValue,
      tuning: this.chroma.tuning,
      delay: this.chroma.delay,
    }
  }

  /** End of input: decide every remaining frame. Returns the chords that became final (call state() before to collect earlier ones). */
  finish(): AnalyzerChord[] {
    if (this.ended) return []
    this.ended = true
    const tail = this.resampler.flush()
    this.process(tail, true)
    for (const r of this.decoder.finish()) this.pendingFinal.push(this.toChord(r, true))
    const out = this.takeFinal()
    if (out.length) out[out.length - 1].end = round(this.time, 3)
    return out.filter((c) => c.end > c.start)
  }

  private takeFinal(): AnalyzerChord[] {
    const out = this.pendingFinal
    this.pendingFinal = []
    return out
  }

  private process(y: Float32Array, final: boolean): void {
    if (y.length) this.remember(y)
    const frames = this.chroma.push(y)
    if (final) frames.push(...this.chroma.flush())
    for (const f of frames) this.frame(f)
    for (const r of this.decoder.takeFinal()) this.pendingFinal.push(this.toChord(r, true))
    if (!final) this.periodic()
  }

  private remember(y: Float32Array): void {
    const n = this.hist.length
    if (y.length >= n) {
      this.hist.set(y.subarray(y.length - n))
      this.histN += y.length
      return
    }
    const pos = this.histN % n
    const first = Math.min(y.length, n - pos)
    this.hist.set(y.subarray(0, first), pos)
    if (first < y.length) this.hist.set(y.subarray(first), 0)
    this.histN += y.length
  }

  /** The last `sec` seconds of 22.05 kHz audio, oldest first. */
  private recent(sec: number): Float32Array {
    const n = this.hist.length
    const len = Math.min(Math.round(sec * SR), n, this.histN)
    const out = new Float32Array(len)
    const end = this.histN % n
    const start = (end - len + n) % n
    if (start + len <= n) out.set(this.hist.subarray(start, start + len))
    else {
      out.set(this.hist.subarray(start), 0)
      out.set(this.hist.subarray(0, len - (n - start)), n - start)
    }
    return out
  }

  private silenceThreshold(rmsDb: number): number {
    this.loud[this.loudN % this.loud.length] = rmsDb
    this.loudN++
    const n = Math.min(this.loudN, this.loud.length)
    const p95 = percentile(this.loud.subarray(0, n), 95)
    return Math.max(this.params.silenceDb, p95 - 45)
  }

  /** Scores of one frame, exactly as the offline decodeChords(). */
  private frame(f: ChromaFrame): void {
    const silent = f.rmsDb < this.silenceThreshold(f.rmsDb)
    const scores = frameScores(f.treble, f.bass, silent, this.vocab, this.params, this.U, this.bassLog)
    const flat = chromaEntropy(f.treble)
    if (flat > NOISE_ENTROPY_LO) scores[this.V] += NOISE_BONUS * Math.min(1, (flat - NOISE_ENTROPY_LO) / (NOISE_ENTROPY_HI - NOISE_ENTROPY_LO))
    this.decoder.push(scores, this.beatPenalty(f.index))
    if (!silent) {
      // decaying mean of the voiced treble chroma for the key profile
      const a = Math.exp(-1 / (CHROMA_DECAY_SEC * FPS))
      for (let i = 0; i < 12; i++) this.chromaMean[i] = a * this.chromaMean[i] + (1 - a) * f.treble[i]
      this.chromaWeight = a * this.chromaWeight + (1 - a)
    }
  }

  private minFrames(tempo: number | null): number {
    const ibi = tempo && tempo > 0 ? 60 / tempo : 0.5
    const minDur = Math.min(1.2, Math.max(0.3, this.params.minSegmentBeats * ibi))
    return Math.ceil(minDur * FPS - 1e-9)
  }

  private periodic(): void {
    const t = this.time
    if (this.autoTuning && t >= this.nextTuningAt) {
      this.tuningStep++
      this.nextTuningAt = this.tuningStep < TUNING_AT.length ? TUNING_AT[this.tuningStep] : t + TUNING_EVERY
      const y = this.recent(HISTORY_SEC)
      if (this.loudEnough(y)) {
        const tuning = estimateTuning(y)
        if (Math.abs(tuning - this.chroma.tuning) > 0.03) this.chroma.setTuning(tuning)
      }
    }
    if (this.tempoOn && t >= this.nextTempoAt) {
      this.nextTempoAt = t + TEMPO_EVERY
      this.updateRhythm()
    }
    if (t >= this.nextKeyAt) {
      this.nextKeyAt = t + KEY_EVERY
      this.updateKey()
    }
  }

  /** Tempo (median of recent estimates) and beats of the last TEMPO_WINDOW seconds. */
  private updateRhythm(): void {
    const y = this.recent(TEMPO_WINDOW)
    if (!this.loudEnough(y)) return
    const env = onsetEnvelope(y)
    const bpm = estimateTempo(env)
    if (!(bpm > 0)) return
    this.tempos.push(bpm)
    if (this.tempos.length > 5) this.tempos.shift()
    if (this.tempos.length < 2) return
    this.tempoValue = round(median(this.tempos), 1)
    this.decoder.setMinFrames(this.minFrames(this.tempoValue))
    if (!this.beatsOn) return
    const start = (this.histN - y.length) / SR
    const fresh = trackBeats(env, this.tempoValue).map((b) => b + start)
    if (fresh.length < 4) return
    // beats tracked earlier stay for the start of this window (its DP has no history there)
    const cut = start + 4
    const keepFrom = start + y.length / SR - 60
    const beats = [...this.beatTimes.filter((b) => b < cut && b > keepFrom), ...fresh.filter((b) => b >= cut)]
    this.beatTimes = beats
    this.beatMids = beats.slice(1).map((b, i) => 0.5 * (beats[i] + b))
  }

  /** Extra switch cost into frame `t`, as the offline changePenalties(): free on a beat, half on an off-beat. */
  private beatPenalty(t: number): number {
    const beats = this.beatTimes
    if (!this.beatsOn || beats.length < 4 || !this.tempoValue) return 0
    const ibi = 60 / this.tempoValue
    const time = (t - 0.5) / FPS
    if (time < beats[0] - ibi) return 0
    const tol = Math.min(0.075, 0.3 * ibi)
    let d: number
    let dHalf: number
    const last = beats[beats.length - 1]
    if (time > last) {
      // past the tracked beats: continue the grid at the current tempo
      if (time > last + 4 * ibi) return 0
      const k = (time - last) / ibi
      const frac = k - Math.floor(k)
      d = Math.min(frac, 1 - frac) * ibi
      dHalf = Math.abs(frac - 0.5) * ibi
    } else {
      d = nearestDistance(beats, time)
      dHalf = nearestDistance(this.beatMids, time)
    }
    if (d <= tol) return 0
    if (dHalf <= tol) return this.params.halfBeatPenalty
    return this.params.offBeatPenalty
  }

  private loudEnough(y: Float32Array): boolean {
    if (y.length < SR) return false
    let e = 0
    for (let i = 0; i < y.length; i++) e += y[i] * y[i]
    return 10 * Math.log10(e / y.length + 1e-12) > this.params.silenceDb
  }

  private updateKey(): void {
    // chords of the last KEY_WINDOW seconds (final + open), with their durations
    const fps = FPS
    const now = this.decoder.frames / fps
    const from = now - KEY_WINDOW
    const list: [Chord, number][] = []
    let voiced = 0
    const add = (start: number, end: number, chord: Chord) => {
      const d = Math.min(end, now) - Math.max(start, from)
      if (d <= 0 || chord.root === null) return
      list.push([chord, d])
      voiced += d
    }
    this.finals = this.finals.filter((r) => r.end > from)
    for (const r of this.finals) add(r.start, r.end, r.chord)
    for (const r of this.decoder.open()) add(r.first / fps, r.last / fps, this.chordOf(r.state))
    if (voiced < KEY_MIN_SEC) return
    const mean = this.chromaWeight > 0 ? this.chromaMean.map((v) => v / this.chromaWeight) : null
    const s = keyScores(list, mean)
    let best = 0
    for (let i = 1; i < 24; i++) if (s[i] > s[best]) best = i
    let z = 0
    for (let i = 0; i < 24; i++) z += Math.exp((s[i] - s[best]) * 4)
    const tonic = PITCH_NAMES[best % 12]
    const mode = best < 12 ? 'major' : 'minor'
    const info: KeyInfo = { tonic, mode, name: tonic + (mode === 'major' ? '' : 'm'), confidence: round(1 / z, 3) }
    if (!this.keyShown || this.keyShown.name === info.name) {
      this.keyShown = info
      this.keyCandidate = -1
      this.keyStreak = 0
      return
    }
    this.keyStreak = this.keyCandidate === best ? this.keyStreak + 1 : 1
    this.keyCandidate = best
    if (this.keyStreak >= KEY_SWITCH_AFTER) {
      this.keyShown = info
      this.keyStreak = 0
      this.keyCandidate = -1
    }
  }

  private chordOf(state: number): Chord {
    return state < this.V ? this.vocab.chords[state] : { root: null, quality: null, bass: null }
  }

  private toChord(r: DecodedRun, final = false): AnalyzerChord {
    const chord = this.chordOf(r.state)
    const start = r.first === 0 ? 0 : (r.first - 0.5) / FPS
    const end = (r.last - 0.5) / FPS
    if (final) this.finals.push({ start, end, chord })
    let conf = r.confidence
    if (chord.quality && chord.quality !== 'maj' && chord.quality !== 'min') conf *= EXTENDED_CONFIDENCE
    return {
      start: round(Math.max(0, start), 3),
      end: round(Math.max(0, end), 3),
      label: chordFields(chord).label,
      confidence: round(Math.min(1, Math.max(0, conf)), 3),
      provisional: final ? false : !r.confirmed,
    }
  }
}
