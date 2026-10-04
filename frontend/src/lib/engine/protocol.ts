// Messages between the main thread (index.ts) and the analysis worker (worker.ts).
import type { BrowserAnalysis, BrowserEngineErrorCode } from './core/types.ts'

export interface AnalyzeRequest {
  type: 'analyze'
  /** mono PCM (transferred, not copied) */
  samples: Float32Array
  sampleRate: number
  /** exact decoded duration (s) */
  duration: number
}

export type WorkerMessage =
  | { type: 'progress'; fraction: number; message: string }
  | { type: 'result'; analysis: BrowserAnalysis }
  | { type: 'error'; code: BrowserEngineErrorCode; message: string }
