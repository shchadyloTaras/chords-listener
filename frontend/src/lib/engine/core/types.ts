// Result shape of the in-browser engine == backend engine contract (docs/SPEC.md "Engine contract").
import type { ChordSegment, ErrorCode, KeyInfo } from '../../../types'

/** Same shape as the backend engine contract in docs/SPEC.md ("Engine contract"). */
export interface BrowserAnalysis {
  duration: number
  tempo: number
  timeSignature: number
  beats: number[]
  downbeats: number[]
  chords: ChordSegment[]
  key: KeyInfo
  waveform: number[]
  engine: string
}

/** fraction 0..1, short English stage message */
export type BrowserProgress = (fraction: number, message: string) => void

/** Failure codes of the in-browser engine (a subset of the API's ErrorCode). */
export type BrowserEngineErrorCode = Extract<ErrorCode, 'unsupported_format' | 'too_long' | 'too_large' | 'analysis_failed'>

/** A failure that is the input's fault or an engine crash; `code` maps to the localized API error texts. */
export class BrowserEngineError extends Error {
  readonly code: BrowserEngineErrorCode

  constructor(code: BrowserEngineErrorCode, message: string) {
    super(message)
    this.name = 'BrowserEngineError'
    this.code = code
  }
}
