// Input level and time without chord analysis (a microphone recording: the chords come from the full
// analysis of the recording). Same shape as LiveAnalyzer for the worker: state() has no chords, key
// or tempo; push() only sums squares, so it costs next to nothing.

import type { AnalyzerChord, LiveAnalysisState } from './analyzer.ts'

/** the meter's floor: -60 dBFS reads 0, 0 dBFS reads 1 */
const METER_FLOOR_DB = -60

/** Mean square of the input since the last take(), as a 0..1 meter level (-60..0 dBFS). */
export class InputLevel {
  private sum = 0
  private n = 0

  add(x: Float32Array): void {
    let s = 0
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      s += Number.isFinite(v) ? v * v : 0
    }
    this.sum += s
    this.n += x.length
  }

  take(): number {
    const ms = this.n ? this.sum / this.n : 0
    this.sum = 0
    this.n = 0
    const db = 10 * Math.log10(ms + 1e-12)
    return Math.round(Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) * 1000) / 1000
  }
}

export class LevelMeter {
  readonly inputRate: number
  private readonly level = new InputLevel()
  private inputSamples = 0
  private ended = false

  constructor(options: { inputRate: number }) {
    this.inputRate = options.inputRate
  }

  /** Seconds of input received. */
  get time(): number {
    return this.inputSamples / this.inputRate
  }

  push(x: Float32Array): void {
    if (this.ended) return
    this.level.add(x)
    this.inputSamples += x.length
  }

  state(): LiveAnalysisState {
    return { time: this.time, finalized: [], open: [], level: this.level.take(), key: null, tempo: null, tuning: 0, delay: 0 }
  }

  finish(): AnalyzerChord[] {
    this.ended = true
    return []
  }
}
