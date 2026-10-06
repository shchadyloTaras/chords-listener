// Module Web Worker: all live DSP runs here, off the main thread. PCM arrives from the capture
// AudioWorklet over a MessagePort (or as 'pcm' messages without a worklet); the worker posts
// small updates to the main thread at most every UPDATE_INTERVAL_MS while audio flows.
// Worker timers are not throttled like a background tab's, and PCM delivery never touches the
// main thread, so analysis keeps up while the tab is hidden.

import { LiveAnalyzer, type AnalyzerChord } from './core/analyzer.ts'
import { LevelMeter } from './core/meter.ts'
import { UPDATE_INTERVAL_MS, type FromWorker, type FromWorklet, type ToWorker } from './protocol.ts'

/** The bits of DedicatedWorkerGlobalScope used here (the app's tsconfig has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker): void
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

const scope = self as unknown as WorkerScope

/** the chord analyzer, or only a level meter when the session does not analyze */
let analyzer: LiveAnalyzer | LevelMeter | null = null
let port: MessagePort | null = null
let interval = UPDATE_INTERVAL_MS
let lastPost = -Infinity
let timer = 0
let finished = false
let failed = false
/** all final chords, for the result */
const finals: AnalyzerChord[] = []
// load = processing time / audio time over the whole session
let busyMs = 0
let audioMs = 0

function fail(err: unknown): void {
  if (failed) return
  failed = true
  if (timer) scope.clearTimeout(timer)
  timer = 0
  const message = err instanceof Error ? err.message : String(err)
  scope.postMessage({ type: 'error', message: `live analysis failed: ${message}` })
}

function post(): void {
  timer = 0
  if (!analyzer || failed) return
  try {
    lastPost = performance.now()
    const st = analyzer.state()
    finals.push(...st.finalized)
    const load = audioMs > 0 ? busyMs / audioMs : 0
    scope.postMessage({
      type: 'update',
      time: st.time,
      finalized: st.finalized,
      open: st.open,
      level: st.level,
      key: st.key,
      tempo: st.tempo,
      load: Math.round(load * 1e4) / 1e4,
      delay: st.delay,
      tuning: st.tuning,
    })
  } catch (err) {
    fail(err)
  }
}

function schedule(): void {
  if (timer) return
  const wait = interval - (performance.now() - lastPost)
  if (wait <= 0) post()
  else timer = scope.setTimeout(post, wait)
}

function ingest(samples: Float32Array): void {
  if (!analyzer || finished || failed || !(samples instanceof Float32Array)) return
  const t0 = performance.now()
  try {
    analyzer.push(samples)
  } catch (err) {
    fail(err)
    return
  }
  busyMs += performance.now() - t0
  audioMs += (samples.length / analyzer.inputRate) * 1000
  schedule()
}

function finish(): void {
  if (finished || !analyzer) return
  finished = true
  if (timer) scope.clearTimeout(timer)
  timer = 0
  if (port) port.onmessage = null
  if (failed) return
  try {
    const st = analyzer.state()
    finals.push(...st.finalized, ...analyzer.finish())
    scope.postMessage({ type: 'result', chords: finals, duration: analyzer.time })
  } catch (err) {
    fail(err)
  }
}

scope.onmessage = (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'init':
      if (analyzer) return
      try {
        analyzer =
          msg.analyze === false
            ? new LevelMeter({ inputRate: msg.sampleRate })
            : new LiveAnalyzer({ ...msg.options, inputRate: msg.sampleRate })
      } catch (err) {
        fail(err)
        return
      }
      interval = msg.interval ?? UPDATE_INTERVAL_MS
      if (msg.port) {
        port = msg.port
        port.onmessage = (e: MessageEvent<FromWorklet>) => {
          const m = e.data
          if (m?.type === 'pcm') ingest(m.samples)
          else if (m?.type === 'end') finish()
        }
      }
      break
    case 'pcm':
      ingest(msg.samples)
      break
    case 'pause':
    case 'resume':
      // the worklet stops / restarts sending; post the state now so the meter drops at once
      if (analyzer && !finished) post()
      break
    case 'finish':
      finish()
      break
  }
}
