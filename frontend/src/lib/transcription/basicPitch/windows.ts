// Framing of the audio into model windows and the exact time of every kept output frame.
//
// Like the reference implementation, the audio gets LEAD_PADDING zeros in front and is cut into
// windows of WINDOW_SAMPLES every WINDOW_HOP samples (the last one zero-padded). Of the 172 output
// frames of a window, TRIM_FRAMES are dropped on each side, so kept frame j of window w is centered
// on audio sample w·WINDOW_HOP + j·FFT_HOP. Consecutive windows advance 141.3 frames but keep 142,
// hence frame times are computed exactly per window instead of as index·hop (the reference
// approximates this with a correction every 172 frames, which errs by up to ~9 ms).
import { FFT_HOP, FRAMES_KEPT, LEAD_PADDING, SAMPLE_RATE, WINDOW_HOP, WINDOW_SAMPLES } from './constants.ts'

export interface FramePlan {
  /** model windows to evaluate */
  windows: number
  /** kept frames over the whole audio */
  frames: number
  /** kept frames of each window (all FRAMES_KEPT except possibly the last) */
  framesInWindow(w: number): number
  /** audio time (s) of every kept frame, increasing */
  times: Float64Array
}

export function planFrames(nSamples: number): FramePlan {
  const windows = Math.max(1, Math.ceil(nSamples / WINDOW_HOP))
  const counts = new Int32Array(windows)
  let frames = 0
  for (let w = 0; w < windows; w++) {
    // frames whose center lies inside the audio (at least one frame per window)
    const remaining = Math.ceil((nSamples - w * WINDOW_HOP) / FFT_HOP)
    counts[w] = Math.max(1, Math.min(FRAMES_KEPT, remaining))
    frames += counts[w]
  }
  const times = new Float64Array(frames)
  let f = 0
  for (let w = 0; w < windows; w++) {
    for (let j = 0; j < counts[w]; j++) times[f++] = (w * WINDOW_HOP + j * FFT_HOP) / SAMPLE_RATE
  }
  return { windows, frames, framesInWindow: (w) => counts[w] ?? 0, times }
}

/** Copies model window `w` (with the leading zero padding and zero tail) into `out` (WINDOW_SAMPLES long). */
export function fillWindow(samples: Float32Array, w: number, out: Float32Array): void {
  const start = w * WINDOW_HOP - LEAD_PADDING
  out.fill(0)
  const from = Math.max(0, start)
  const to = Math.min(samples.length, start + WINDOW_SAMPLES)
  if (to > from) out.set(samples.subarray(from, to), from - start)
}

/** Time (s) at a fractional frame position, interpolating the frame-time table. */
export function timeAt(times: Float64Array, pos: number): number {
  const n = times.length
  if (!n) return 0
  if (pos <= 0) return times[0] + pos * (FFT_HOP / SAMPLE_RATE)
  if (pos >= n - 1) return times[n - 1] + (pos - (n - 1)) * (FFT_HOP / SAMPLE_RATE)
  const i = Math.floor(pos)
  const f = pos - i
  return times[i] + f * (times[i + 1] - times[i])
}
