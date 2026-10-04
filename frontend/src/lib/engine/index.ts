// In-browser chord recognition (used when the local server is not reachable, e.g. on GitHub Pages).
// The main thread only decodes; all DSP runs in a module Web Worker (./worker.ts).
//
//   const analysis = await analyzeInBrowser(file, (fraction, message) => ..., { signal })
//
// Resolves with the backend engine contract shape (docs/SPEC.md "Engine contract").
// Rejects with a BrowserEngineError (`code`: unsupported_format | too_long | too_large |
// analysis_failed), or with the signal's reason (an "AbortError" DOMException) when aborted.
import { ANALYSIS_RATE, ENGINE_LABEL } from './core/analyze.ts'
import { BrowserEngineError, type BrowserAnalysis, type BrowserProgress } from './core/types.ts'
import { canDecodeAudio, decodeToMono, type DecodedAudio } from './decode.ts'
import type { AnalyzeRequest, WorkerMessage } from './protocol.ts'

export type { BrowserAnalysis, BrowserEngineErrorCode, BrowserProgress } from './core/types.ts'
export { BrowserEngineError } from './core/types.ts'

/** "name version" of the in-browser engine (the `engine` field of its results). */
export const BROWSER_ENGINE = ENGINE_LABEL
/** Same limits as the server defaults (CHORDS_MAX_DURATION_MIN / CHORDS_MAX_UPLOAD_MB). */
export const BROWSER_MAX_DURATION_SEC = 30 * 60
export const BROWSER_MAX_FILE_BYTES = 500 * 1024 * 1024

export interface BrowserAnalyzeOptions {
  signal?: AbortSignal
}

/** True when this browser can decode audio and run module workers. */
export function isBrowserEngineSupported(): boolean {
  return typeof Worker !== 'undefined' && canDecodeAudio()
}

// share of the overall progress spent before the worker starts (reading + decoding)
const DECODE_SHARE = 0.12

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The analysis was aborted.', 'AbortError')
}

/** Resolve/reject with `p`, or reject as soon as `signal` aborts. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** Decodes any browser-decodable audio/video Blob and analyzes it off the main thread. */
export async function analyzeInBrowser(
  file: Blob,
  onProgress?: BrowserProgress,
  options: BrowserAnalyzeOptions = {},
): Promise<BrowserAnalysis> {
  const { signal } = options
  if (signal?.aborted) throw abortReason(signal)
  let last = 0
  const report: BrowserProgress = (fraction, message) => {
    last = Math.min(1, Math.max(last, fraction))
    onProgress?.(last, message)
  }
  if (file.size === 0) throw new BrowserEngineError('unsupported_format', 'the file is empty')
  if (file.size > BROWSER_MAX_FILE_BYTES) {
    throw new BrowserEngineError('too_large', `the file is larger than ${BROWSER_MAX_FILE_BYTES / 1024 / 1024} MB`)
  }
  if (!isBrowserEngineSupported()) {
    throw new BrowserEngineError('analysis_failed', 'this browser cannot analyze audio (Web Audio or Web Workers unavailable)')
  }

  report(0, 'Reading file')
  const data = await abortable(file.arrayBuffer(), signal)
  report(0.02, 'Decoding audio')
  let audio: DecodedAudio
  try {
    audio = await abortable(decodeToMono(data, ANALYSIS_RATE), signal)
  } catch (err) {
    if (signal?.aborted) throw abortReason(signal)
    const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
    throw new BrowserEngineError('unsupported_format', `could not decode audio${detail}`)
  }
  if (audio.duration > BROWSER_MAX_DURATION_SEC) {
    throw new BrowserEngineError('too_long', `the audio is longer than ${BROWSER_MAX_DURATION_SEC / 60} minutes`)
  }
  report(DECODE_SHARE, 'Starting analysis')
  return runWorker(audio, (f, m) => report(DECODE_SHARE + (1 - DECODE_SHARE) * f, m), signal)
}

function runWorker(audio: DecodedAudio, onProgress: BrowserProgress, signal?: AbortSignal): Promise<BrowserAnalysis> {
  return new Promise<BrowserAnalysis>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'chords-engine' })
    } catch (err) {
      reject(new BrowserEngineError('analysis_failed', `could not start the analysis worker: ${String(err)}`))
      return
    }
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(abortReason(signal!)))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data
      if (msg.type === 'progress') {
        if (!settled) onProgress(msg.fraction, msg.message)
      } else if (msg.type === 'result') {
        finish(() => resolve(msg.analysis))
      } else {
        finish(() => reject(new BrowserEngineError(msg.code, msg.message)))
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault()
      finish(() => reject(new BrowserEngineError('analysis_failed', `the analysis worker crashed: ${event.message || 'unknown error'}`)))
    }
    worker.onmessageerror = () => {
      finish(() => reject(new BrowserEngineError('analysis_failed', 'the analysis worker sent an unreadable message')))
    }
    const request: AnalyzeRequest = {
      type: 'analyze',
      samples: audio.samples,
      sampleRate: audio.sampleRate,
      duration: audio.duration,
    }
    worker.postMessage(request, [audio.samples.buffer])
  })
}
