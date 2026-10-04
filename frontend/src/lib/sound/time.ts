// AudioContext time → performance.now(): when a note scheduled on the audio clock is actually heard.

/** The subset of AudioContext the conversion reads (a plain object in tests). */
export interface AudioClock {
  readonly currentTime: number
  readonly baseLatency?: number
  readonly outputLatency?: number
  getOutputTimestamp?(): { contextTime?: number; performanceTime?: number }
}

/** A context time paired with the performance.now() moment it reaches the listener. */
export interface TimeRef {
  /** AudioContext time, s */
  contextTime: number
  /** performance.now() when `contextTime` is heard, ms */
  performanceTime: number
}

/**
 * Lookahead of the browsers' DynamicsCompressorNode (Blink, WebKit and Gecko share the same
 * kernel): the master limiter delays everything that passes through it by 6 ms.
 */
export const COMPRESSOR_DELAY = 0.006

const finite = (x: number | undefined): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)

/**
 * The browser's output timestamp when it is live: `getOutputTimestamp()` pairs the sample frame
 * leaving the speakers with its performance.now() time, so it already includes the output latency.
 * Null when there is none, or while it is still empty / stale (right after the context starts or
 * resumes, Chrome reports zeros — or the frame from before the pause — for ~50 ms and currentTime
 * does not move yet). `notBefore`: ignore stamps rendered before this performance.now() time
 * (e.g. the moment the context resumed).
 */
export function outputStamp(clock: AudioClock, perfNow: number, notBefore = -Infinity): TimeRef | null {
  let stamp: { contextTime?: number; performanceTime?: number } | undefined
  try {
    stamp = clock.getOutputTimestamp?.()
  } catch {
    return null
  }
  const ct = stamp?.contextTime
  const pt = stamp?.performanceTime
  if (
    typeof ct === 'number' &&
    typeof pt === 'number' &&
    ct > 0 &&
    pt > 0 &&
    ct <= clock.currentTime + 0.005 &&
    clock.currentTime - ct < 1 &&
    Math.abs(perfNow - pt) < 1000 &&
    pt >= notBefore
  ) {
    return { contextTime: ct, performanceTime: pt }
  }
  return null
}

/**
 * Where the audio clock is relative to performance.now() right now: the live output timestamp
 * when there is one, else `currentTime` + `baseLatency` + `outputLatency`. `extraDelay` (s) is
 * added for processing inside our own graph (the limiter's lookahead); `notBefore` as in
 * outputStamp (Infinity = never trust the timestamp).
 */
export function timeRef(clock: AudioClock, perfNow: number, extraDelay = 0, notBefore = -Infinity): TimeRef {
  const stamp = outputStamp(clock, perfNow, notBefore)
  if (stamp) return { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime + extraDelay * 1000 }
  const latency = finite(clock.baseLatency) + finite(clock.outputLatency)
  return { contextTime: clock.currentTime, performanceTime: perfNow + (latency + extraDelay) * 1000 }
}

/** performance.now() (ms) at which audio scheduled at context time `time` (s) is heard. */
export function contextToPerformance(time: number, ref: TimeRef): number {
  return ref.performanceTime + (time - ref.contextTime) * 1000
}
