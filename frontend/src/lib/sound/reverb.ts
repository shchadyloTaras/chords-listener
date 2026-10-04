// A small, warm room for the chord sound: a synthetic stereo impulse response (decorrelated noise
// with an exponential −60 dB decay, a short pre-delay, and highs absorbed faster than lows).

import { mulberry32 } from './dsp'

export interface RoomOptions {
  /** IR length, s */
  seconds?: number
  /** time to fall by 60 dB, s */
  rt60?: number
  /** gap before the first reflection, s */
  preDelay?: number
  seed?: number
}

/** Left / right impulse responses, each normalized to unit energy (so a send gain = wet level). */
export function roomImpulse(sampleRate: number, opts: RoomOptions = {}): [Float32Array, Float32Array] {
  const { seconds = 1.5, rt60 = 1.25, preDelay = 0.014, seed = 2024 } = opts
  const length = Math.max(1, Math.round(seconds * sampleRate))
  const pre = Math.round(preDelay * sampleRate)
  const channels: Float32Array[] = []
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(seed + ch * 7777)
    const x = new Float32Array(length)
    let lp = 0
    let energy = 0
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / sampleRate
      const env = Math.exp((-6.91 * t) / rt60) * Math.min(1, t / 0.004)
      // one-pole lowpass that closes over time: early reflections bright, the tail dark
      const a = 0.12 + 0.85 * Math.exp(-t / 0.35)
      lp += a * (rand() * 2 - 1 - lp)
      x[i] = lp * env
      energy += x[i] * x[i]
    }
    const k = energy > 0 ? 1 / Math.sqrt(energy) : 0
    for (let i = 0; i < length; i++) x[i] *= k
    channels.push(x)
  }
  return [channels[0], channels[1]]
}
