// Where the model runs: a module worker with TF.js WebGL (OffscreenCanvas) when the browser allows it;
// otherwise the page's own WebGL context (yielding between model calls so the UI keeps breathing);
// otherwise the CPU backend in the worker (slow but works everywhere).
import type { NoteEvent } from './compact.ts'
import type { TfBackend, TranscribeStats, WorkerErrorCode, WorkerReply, WorkerRequest } from './protocol.ts'

export class TranscriberError extends Error {
  readonly code: WorkerErrorCode
  constructor(code: WorkerErrorCode, message: string) {
    super(message)
    this.name = 'TranscriberError'
    this.code = code
  }
}

export interface Transcriber {
  backend: TfBackend
  thread: 'worker' | 'page'
  run(samples: Float32Array, onProgress?: (fraction: number, found: number) => void): Promise<{ notes: NoteEvent[]; stats: TranscribeStats }>
  dispose(): void
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Transcription aborted', 'AbortError')
}

function pageHasWebGL(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return gl !== null
  } catch {
    return false
  }
}

/** Starts a worker, picks a backend and loads the model. Rejects with TranscriberError (or the abort reason). */
function startWorker(modelUrl: string, backends: TfBackend[], signal: AbortSignal): Promise<Transcriber> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    let worker: Worker
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'chords-transcribe' })
    } catch (err) {
      return reject(new TranscriberError('no-backend', `could not start a worker: ${String(err)}`))
    }
    let job: { resolve(v: { notes: NoteEvent[]; stats: TranscribeStats }): void; reject(e: unknown): void; progress?(f: number, n: number): void } | null =
      null
    let ready = false
    const onAbort = () => {
      worker.terminate()
      const e = abortError(signal)
      if (job) job.reject(e)
      else reject(e)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const dispose = () => {
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const msg = event.data
      if (msg.type === 'ready') {
        ready = true
        resolve({
          backend: msg.backend,
          thread: 'worker',
          dispose,
          run: (samples, progress) =>
            new Promise((res, rej) => {
              job = { resolve: res, reject: rej, progress }
              const req: WorkerRequest = { type: 'run', samples }
              worker.postMessage(req, [samples.buffer])
            }),
        })
      } else if (msg.type === 'progress') {
        job?.progress?.(msg.fraction, msg.found)
      } else if (msg.type === 'result') {
        job?.resolve({ notes: msg.notes, stats: msg.stats })
        job = null
      } else {
        const err = new TranscriberError(msg.code, msg.message)
        if (ready && job) job.reject(err)
        else if (!ready) {
          dispose()
          reject(err)
        }
        job = null
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault()
      const err = new TranscriberError(ready ? 'failed' : 'no-backend', `the transcription worker crashed: ${event.message || 'unknown error'}`)
      dispose()
      if (job) job.reject(err)
      else reject(err)
      job = null
    }
    const init: WorkerRequest = { type: 'init', modelUrl, backends }
    worker.postMessage(init)
  })
}

/** Runs the pipeline on the main thread (lazy chunk), yielding to the event loop between model calls. */
async function startInPage(modelUrl: string, backends: TfBackend[], signal: AbortSignal): Promise<Transcriber> {
  const pipeline = await import('./pipeline.ts')
  if (signal.aborted) throw abortError(signal)
  const backend = await pipeline.selectBackend(backends)
  if (!backend) throw new TranscriberError('no-backend', 'no TF.js backend is available in this browser')
  try {
    await pipeline.warmUp(await pipeline.loadBasicPitch(modelUrl), backend)
  } catch (err) {
    throw new TranscriberError('model', err instanceof Error ? err.message : String(err))
  }
  const pause = () => new Promise<void>((r) => setTimeout(r, 0))
  return {
    backend,
    thread: 'page',
    dispose: () => undefined,
    run: async (samples, progress) => {
      const { notes, stats } = await pipeline.transcribeSamples(samples, { modelUrl, backend, signal, pause, onProgress: progress })
      return { notes, stats: { ...stats, thread: 'page' } }
    },
  }
}

/** Picks the fastest place to run the model in this browser (see the file comment). */
export async function createTranscriber(modelUrl: string, signal: AbortSignal): Promise<Transcriber> {
  const canWork = typeof Worker !== 'undefined'
  if (canWork) {
    try {
      return await startWorker(modelUrl, ['webgl'], signal)
    } catch (err) {
      if (signal.aborted) throw abortError(signal)
      if (err instanceof TranscriberError && err.code === 'model') throw err
    }
  }
  if (pageHasWebGL()) {
    try {
      return await startInPage(modelUrl, ['webgl'], signal)
    } catch (err) {
      if (signal.aborted) throw abortError(signal)
      if (err instanceof TranscriberError && err.code === 'model') throw err
    }
  }
  if (canWork) {
    try {
      return await startWorker(modelUrl, ['cpu'], signal)
    } catch (err) {
      if (signal.aborted) throw abortError(signal)
      if (err instanceof TranscriberError && err.code === 'model') throw err
    }
  }
  return startInPage(modelUrl, ['cpu'], signal)
}
