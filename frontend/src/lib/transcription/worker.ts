// Module Web Worker: Basic Pitch inference (TF.js WebGL through OffscreenCanvas, or the CPU backend)
// and note decoding, off the main thread. One transcription per worker; the page terminates it to abort.
import { loadBasicPitch, selectBackend, transcribeSamples, warmUp } from './pipeline.ts'
import type { TfBackend, WorkerReply, WorkerRequest } from './protocol.ts'

/** The bits of DedicatedWorkerGlobalScope used here (the app's tsconfig has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerReply): void
}

const scope = self as unknown as WorkerScope
let backend: TfBackend | null = null
let modelUrl = ''

function fail(code: 'no-backend' | 'model' | 'failed', err: unknown): void {
  scope.postMessage({ type: 'error', code, message: err instanceof Error ? err.message : String(err) })
}

scope.onmessage = (event) => {
  const req = event.data
  if (req?.type === 'init') void init(req.modelUrl, req.backends)
  else if (req?.type === 'run') void run(req.samples)
}

async function init(url: string, backends: TfBackend[]): Promise<void> {
  backend = await selectBackend(backends)
  if (!backend) {
    fail('no-backend', new Error(`none of ${backends.join(', ')} works in a worker here`))
    return
  }
  modelUrl = url
  try {
    await warmUp(await loadBasicPitch(url), backend)
  } catch (err) {
    fail('model', err)
    return
  }
  scope.postMessage({ type: 'ready', backend })
}

async function run(samples: Float32Array): Promise<void> {
  if (!backend) {
    fail('failed', new Error('the worker was not initialized'))
    return
  }
  let lastPost = 0
  try {
    const { notes, stats } = await transcribeSamples(samples, {
      modelUrl,
      backend,
      onProgress: (fraction, found) => {
        const now = performance.now()
        if (fraction < 1 && now - lastPost < 100) return
        lastPost = now
        scope.postMessage({ type: 'progress', fraction, found })
      },
    })
    scope.postMessage({ type: 'result', notes, stats: { ...stats, thread: 'worker' } })
  } catch (err) {
    fail('failed', err)
  }
}
