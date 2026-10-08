// Steadies the detector's raw estimates for the display: a level and clarity gate, a short median, a
// new note shown only once it wins several frames in a row, and a brief hold when the sound stops.

import { hzToNote } from './notes'
import type { PitchEstimate } from './pitch'

export interface TunerReading {
  /** median frequency of the last frames, Hz */
  hz: number
  midi: number
  /** deviation from `midi`, -50..+50 */
  cents: number
}

/** quieter frames are silence: −50 dBFS */
export const GATE_RMS = 10 ** (-50 / 20)
/** less periodic frames are not a steady pitch (a pluck's attack, speech, noise) */
export const STEADY_CLARITY = 0.9
export const MEDIAN_OF = 5
export const CONFIRM_FRAMES = 3
export const HOLD_MS = 600

export interface Stabilizer {
  /** One frame: the detector's estimate (null = none), the frame's RMS, its time in ms and the current A4. */
  push(estimate: PitchEstimate | null, rms: number, nowMs: number, a4: number): TunerReading | null
  /** forget everything (after a pause, a stop) */
  reset(): void
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function createStabilizer(): Stabilizer {
  let recent: number[] = []
  let shown: TunerReading | null = null
  let lastHeard = -Infinity
  let candidate: number | null = null
  let streak = 0

  function reset() {
    recent = []
    shown = null
    lastHeard = -Infinity
    candidate = null
    streak = 0
  }

  function push(estimate: PitchEstimate | null, rms: number, nowMs: number, a4: number): TunerReading | null {
    if (!estimate || rms < GATE_RMS || estimate.clarity < STEADY_CLARITY) {
      if (shown && nowMs - lastHeard <= HOLD_MS) return shown
      reset()
      return null
    }
    lastHeard = nowMs
    recent.push(estimate.hz)
    if (recent.length > MEDIAN_OF) recent.shift()
    const hz = median(recent)
    const { midi, cents } = hzToNote(hz, a4)
    if (shown?.midi === midi) {
      candidate = null
      streak = 0
      shown = { hz, midi, cents }
      return shown
    }
    // another note: it shows once it has held for CONFIRM_FRAMES frames in a row
    streak = candidate === midi ? streak + 1 : 1
    candidate = midi
    if (streak >= CONFIRM_FRAMES) {
      candidate = null
      streak = 0
      shown = { hz, midi, cents }
    }
    return shown
  }

  return { push, reset }
}
