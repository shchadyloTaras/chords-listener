// The tuner's reference tone: one sine held until stopped, faded in and out and glided between notes
// so it never clicks. Its own AudioContext, made on the first play() (a click: browsers start audio
// only on a user gesture).

import { audioContextCtor } from './session'

/** the picker's range: C2..C6 */
export const TONE_LOW = 36
export const TONE_HIGH = 84
export const TONE_GAIN = 0.25
/** seconds: fade in / out, and the glide to another note */
export const FADE_S = 0.02
const GLIDE_S = 0.015

export function clampToneMidi(midi: number): number {
  return Math.min(TONE_HIGH, Math.max(TONE_LOW, Math.round(midi)))
}

export interface ReferenceTone {
  readonly playing: boolean
  /** Starts the tone at \`hz\`, or glides the sounding one there. */
  play(hz: number): void
  stop(): void
  /** stop and close the context (leaving the page) */
  dispose(): void
}

export function createReferenceTone(): ReferenceTone {
  let ctx: AudioContext | null = null
  let osc: OscillatorNode | null = null
  let gain: GainNode | null = null

  function play(hz: number) {
    const Ctor = audioContextCtor()
    if (!Ctor) return
    ctx ??= new Ctor({ latencyHint: 'interactive' })
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
    const now = ctx.currentTime
    if (osc) {
      osc.frequency.setTargetAtTime(hz, now, GLIDE_S / 3)
      return
    }
    gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(TONE_GAIN, now + FADE_S)
    gain.connect(ctx.destination)
    osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(hz, now)
    osc.connect(gain)
    osc.start(now)
  }

  function stop() {
    if (!ctx || !osc || !gain) return
    const now = ctx.currentTime
    const o = osc
    const g = gain
    g.gain.cancelScheduledValues(now)
    g.gain.setValueAtTime(g.gain.value, now)
    g.gain.linearRampToValueAtTime(0, now + FADE_S)
    o.onended = () => {
      o.disconnect()
      g.disconnect()
    }
    o.stop(now + FADE_S + 0.01)
    osc = null
    gain = null
  }

  return {
    get playing() {
      return osc !== null
    },
    play,
    stop,
    dispose() {
      stop()
      ctx?.close().catch(() => undefined)
      ctx = null
    },
  }
}
