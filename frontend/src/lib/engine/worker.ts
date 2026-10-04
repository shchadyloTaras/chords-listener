// Module Web Worker: runs the whole DSP pipeline off the main thread.
import { analyzeSignal } from './core/analyze.ts'
import { BrowserEngineError } from './core/types.ts'
import type { AnalyzeRequest, WorkerMessage } from './protocol.ts'

/** The bits of DedicatedWorkerGlobalScope used here (the app's tsconfig has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null
  postMessage(message: WorkerMessage): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  const req = event.data
  if (!req || req.type !== 'analyze') return
  let lastFraction = -1
  let lastMessage = ''
  try {
    const analysis = analyzeSignal(req.samples, req.sampleRate, {
      duration: req.duration,
      onProgress: (fraction, message) => {
        // throttle: post on stage changes and every 1 %
        if (message === lastMessage && fraction - lastFraction < 0.01 && fraction < 1) return
        lastFraction = fraction
        lastMessage = message
        scope.postMessage({ type: 'progress', fraction, message })
      },
    })
    scope.postMessage({ type: 'result', analysis })
  } catch (err) {
    const code = err instanceof BrowserEngineError ? err.code : 'analysis_failed'
    const detail = err instanceof Error ? err.message : String(err)
    const message = err instanceof RangeError && /allocation|memory/i.test(detail)
      ? 'not enough memory to analyze this file'
      : `chord analysis failed: ${detail}`
    scope.postMessage({ type: 'error', code, message: err instanceof BrowserEngineError ? detail : message })
  }
}
