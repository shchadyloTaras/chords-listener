// Runs the Basic Pitch graph model window by window (TF.js; any backend) and assembles the note
// and onset activations of the whole track with exact per-frame times.
import * as tf from '@tensorflow/tfjs-core'
import type { GraphModel } from '@tensorflow/tfjs-converter'
import { FRAMES_PER_WINDOW, N_PITCHES, OUTPUT_FRAMES, OUTPUT_ONSETS, TRIM_FRAMES, WINDOW_SAMPLES } from './constants.ts'
import { fillWindow, planFrames } from './windows.ts'

export interface Posteriorgram {
  nFrames: number
  /** note activations, row-major [nFrames × 88] (A0 … C8) */
  frames: Float32Array
  /** onset activations, same layout */
  onsets: Float32Array
  /** audio time (s) of every frame */
  times: Float64Array
}

export interface InferProgress {
  windowsDone: number
  windowsTotal: number
  /** frames filled so far; `partial` holds them (the arrays are complete up to framesDone) */
  framesDone: number
  partial: Posteriorgram
}

export interface InferOptions {
  /** windows evaluated per model call (bigger = faster on GPUs, coarser progress) */
  batch?: number
  /**
   * Always feed exactly `batch` windows (the last call zero-padded): one input shape for the whole
   * run, so the WebGL backend compiles its shaders once instead of again for the remainder.
   */
  fixedBatch?: boolean
  signal?: AbortSignal
  onProgress?(p: InferProgress): void
  /** awaited between batches, e.g. to let the main thread breathe */
  pause?(): Promise<void>
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Transcription aborted', 'AbortError')
}

/** Evaluates the model over `samples` (mono, 22 050 Hz). */
export async function runModel(model: GraphModel, samples: Float32Array, opts: InferOptions = {}): Promise<Posteriorgram> {
  const plan = planFrames(samples.length)
  const batch = Math.max(1, Math.floor(opts.batch ?? 1))
  const frames = new Float32Array(plan.frames * N_PITCHES)
  const onsets = new Float32Array(plan.frames * N_PITCHES)
  const partial: Posteriorgram = { nFrames: plan.frames, frames, onsets, times: plan.times }
  let frame = 0
  const input = new Float32Array(batch * WINDOW_SAMPLES)
  for (let w0 = 0; w0 < plan.windows; w0 += batch) {
    aborted(opts.signal)
    const n = Math.min(batch, plan.windows - w0)
    const fed = opts.fixedBatch ? batch : n
    for (let b = 0; b < n; b++) fillWindow(samples, w0 + b, input.subarray(b * WINDOW_SAMPLES, (b + 1) * WINDOW_SAMPLES))
    if (fed > n) input.fill(0, n * WINDOW_SAMPLES)
    const x = tf.tensor3d(input.subarray(0, fed * WINDOW_SAMPLES), [fed, WINDOW_SAMPLES, 1])
    let out: tf.Tensor[] = []
    let data: [Float32Array, Float32Array]
    try {
      out = model.execute(x, [OUTPUT_FRAMES, OUTPUT_ONSETS]) as tf.Tensor[]
      data = (await Promise.all([out[0].data(), out[1].data()])) as [Float32Array, Float32Array]
    } finally {
      x.dispose()
      for (const t of out) t.dispose()
    }
    const [f, o] = data
    for (let b = 0; b < n; b++) {
      const keep = plan.framesInWindow(w0 + b)
      const from = (b * FRAMES_PER_WINDOW + TRIM_FRAMES) * N_PITCHES
      frames.set(f.subarray(from, from + keep * N_PITCHES), frame * N_PITCHES)
      onsets.set(o.subarray(from, from + keep * N_PITCHES), frame * N_PITCHES)
      frame += keep
    }
    opts.onProgress?.({ windowsDone: w0 + n, windowsTotal: plan.windows, framesDone: frame, partial })
    if (opts.pause) await opts.pause()
  }
  return partial
}
