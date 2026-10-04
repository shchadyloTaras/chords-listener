// Messages between the page and the transcription worker (worker.ts):
//   page → {init} → worker picks a TF.js backend and loads the model (while the page decodes audio)
//   worker → {ready} | {error}
//   page → {run, samples} → worker → {progress}… → {result} | {error}
import type { NoteEvent } from './compact.ts'

export type TfBackend = 'webgl' | 'cpu'

export type WorkerRequest =
  | {
      type: 'init'
      /** absolute URL of model.json */
      modelUrl: string
      /** backends to try, in order */
      backends: TfBackend[]
    }
  | {
      type: 'run'
      /** mono PCM at 22 050 Hz (transferred) */
      samples: Float32Array
    }

export interface TranscribeStats {
  backend: TfBackend
  /** where the model ran */
  thread: 'worker' | 'page'
  /** model evaluation, ms */
  modelMs: number
  /** note decoding, ms */
  decodeMs: number
  windows: number
}

export type WorkerErrorCode = 'no-backend' | 'model' | 'failed'

export type WorkerReply =
  | { type: 'ready'; backend: TfBackend }
  | { type: 'progress'; fraction: number; found: number }
  | { type: 'result'; notes: NoteEvent[]; stats: TranscribeStats }
  | { type: 'error'; code: WorkerErrorCode; message: string }
