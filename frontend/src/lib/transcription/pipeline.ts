// The heavy part of transcription — TF.js (slim: core + converter + WebGL/CPU backends), the Basic
// Pitch model and note decoding. Imported only by the worker (worker.ts) or, as a fallback, lazily by
// the page (runner.ts): never part of the main bundle.
import * as tf from '@tensorflow/tfjs-core'
import '@tensorflow/tfjs-backend-cpu'
import '@tensorflow/tfjs-backend-webgl'
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter'
import { OUTPUT_FRAMES, OUTPUT_ONSETS, WINDOW_HOP, WINDOW_SAMPLES } from './basicPitch/constants.ts'
import { runModel } from './basicPitch/infer.ts'
import { posteriorgramToNotes } from './basicPitch/notes.ts'
import type { NoteEvent } from './compact.ts'
import type { TfBackend, TranscribeStats } from './protocol.ts'

/** Switches TF.js to the first backend of `candidates` that initializes; null when none does. */
export async function selectBackend(candidates: readonly TfBackend[]): Promise<TfBackend | null> {
  for (const name of candidates) {
    try {
      if (tf.getBackend() === name) return name
      if (await tf.setBackend(name)) {
        await tf.ready()
        return name
      }
    } catch {
      /* try the next one */
    }
  }
  return null
}

let model: { url: string; promise: Promise<GraphModel> } | null = null

export function loadBasicPitch(url: string): Promise<GraphModel> {
  if (model?.url !== url) {
    const promise = loadGraphModel(url)
    model = { url, promise }
    promise.catch(() => {
      if (model?.promise === promise) model = null
    })
  }
  return model.promise
}

/**
 * Windows per model call. On WebGL bigger batches are a little faster per window (M4 Pro: 18 ms at 1,
 * 10 at 4, 5.5 at 8) but the model's activations need ~360 MB of GPU textures per window (2.9 GB at
 * 8 — too much for integrated GPUs), so one window at a time: still ~0.7 s per minute of audio.
 */
export function batchFor(_backend: TfBackend): number {
  return 1
}

interface CompileAware {
  checkCompileCompletionAsync?(): Promise<unknown>
  getUniformLocations?(): void
}

/**
 * Compiles the WebGL shaders for the model's (single, fixed) input shape up front, in parallel where
 * the GPU driver allows (KHR_parallel_shader_compile). Runs while the page is still fetching and
 * decoding the audio; without it the first model call pays for compiling ~150 programs one by one.
 */
export async function warmUp(graph: GraphModel, backend: TfBackend): Promise<void> {
  if (backend !== 'webgl') return
  const x = tf.zeros([batchFor(backend), WINDOW_SAMPLES, 1])
  let out: tf.Tensor[] = []
  try {
    tf.env().set('ENGINE_COMPILE_ONLY', true)
    out = graph.execute(x, [OUTPUT_FRAMES, OUTPUT_ONSETS]) as tf.Tensor[]
    const be = tf.backend() as unknown as CompileAware
    await be.checkCompileCompletionAsync?.()
    be.getUniformLocations?.()
  } catch {
    /* not supported: shaders compile on first use instead */
  } finally {
    tf.env().set('ENGINE_COMPILE_ONLY', false)
    tf.dispose(out)
    x.dispose()
  }
}

export interface PipelineOptions {
  modelUrl: string
  backend: TfBackend
  signal?: AbortSignal
  /** model progress 0..1 and the notes found so far (decoded from the part already evaluated) */
  onProgress?(fraction: number, found: number): void
  /** awaited between model calls (main-thread runs yield here) */
  pause?(): Promise<void>
}

/** Mono 22 050 Hz PCM → note events. */
export async function transcribeSamples(
  samples: Float32Array,
  opts: PipelineOptions,
): Promise<{ notes: NoteEvent[]; stats: Omit<TranscribeStats, 'thread'> }> {
  const graph = await loadBasicPitch(opts.modelUrl)
  const t0 = performance.now()
  // the running note count: decode what is evaluated so far now and then (fast, but not free on long
  // songs: at most every second and never more than ~10 % of the time)
  let found = 0
  let nextCount = t0 + 600
  let countCost = 0
  const pg = await runModel(graph, samples, {
    batch: batchFor(opts.backend),
    // one input shape for the whole run: WebGL compiles its shaders once (see warmUp)
    fixedBatch: opts.backend === 'webgl',
    signal: opts.signal,
    pause: opts.pause,
    onProgress: (p) => {
      const now = performance.now()
      if (p.windowsDone < p.windowsTotal && now >= nextCount && p.framesDone > 1) {
        found = posteriorgramToNotes({ ...p.partial, nFrames: p.framesDone }).length
        countCost = performance.now() - now
        nextCount = performance.now() + Math.max(1000, 10 * countCost)
      }
      opts.onProgress?.(p.windowsDone / p.windowsTotal, found)
    },
  })
  const t1 = performance.now()
  const notes = posteriorgramToNotes(pg)
  const t2 = performance.now()
  return {
    notes,
    stats: {
      backend: opts.backend,
      modelMs: Math.round(t1 - t0),
      decodeMs: Math.round(t2 - t1),
      windows: Math.max(1, Math.ceil(samples.length / WINDOW_HOP)),
    },
  }
}
