// Messages between the main thread (session.ts), the capture AudioWorklet
// (capture.worklet.ts) and the analysis worker (worker.ts).
//
//   AudioWorklet --(MessageChannel: mono PCM batches)--> worker --(<= 10 Hz updates)--> main
//   main --(node.port: pause / resume / end)--> AudioWorklet
//   main --(init / pause / resume / finish [/ pcm without a worklet])--> worker

import type { KeyInfo } from '../../types'
import type { AnalyzerChord, LiveAnalyzerOptions } from './core/analyzer.ts'

export const WORKLET_NAME = 'chords-live-capture'
/** samples per PCM message from the worklet (~43 ms at 48 kHz) */
export const WORKLET_BATCH = 2048
/** minimum time between updates to the main thread (ms) */
export const UPDATE_INTERVAL_MS = 100

export type AnalyzerTuning = Omit<LiveAnalyzerOptions, 'inputRate'>

export type ToWorker =
  | {
      type: 'init'
      sampleRate: number
      /** PCM arrives on this port (from the AudioWorklet); without it as 'pcm' messages */
      port?: MessagePort
      options?: AnalyzerTuning
      interval?: number
    }
  | { type: 'pcm'; samples: Float32Array }
  | { type: 'pause' }
  | { type: 'resume' }
  /** end of input: analyze what is left and answer with 'result' */
  | { type: 'finish' }

/** worklet -> worker, over the MessageChannel */
export type FromWorklet = { type: 'pcm'; samples: Float32Array } | { type: 'end' }

/** main -> worklet, over node.port */
export type ToWorklet = { type: 'port'; port: MessagePort } | { type: 'pause' } | { type: 'resume' } | { type: 'end' }

export interface WorkerUpdate {
  type: 'update'
  /** seconds of audio analyzed (pauses excluded) */
  time: number
  /** chords that became final since the previous update */
  finalized: AnalyzerChord[]
  /** the chords after them; the last one is the current chord */
  open: AnalyzerChord[]
  level: number
  key: KeyInfo | null
  tempo: number | null
  load: number
  delay: number
  tuning: number
}

export type FromWorker =
  | WorkerUpdate
  | { type: 'result'; chords: AnalyzerChord[]; duration: number }
  | { type: 'error'; message: string }
