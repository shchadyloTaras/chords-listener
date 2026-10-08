// The tuner's microphone graph: the stream into an AnalyserNode (silent, nothing reaches the
// speakers); the page reads the newest window once per animation frame.

import { CaptureError } from '../live'

/** samples per detection window: ≈ 85 ms at 48 kHz, three periods of the lowest bass string */
export const FRAME_SIZE = 4096

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

export function audioContextCtor(): AudioContextCtor | undefined {
  return globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
}

export interface TunerInput {
  readonly sampleRate: number
  /** Copies the newest FRAME_SIZE samples into `into`; returns their RMS level. */
  read(into: Float32Array<ArrayBuffer>): number
  /** Stops the microphone and closes the graph (again: nothing). */
  stop(): void
}

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const

export function startTuner(stream: MediaStream): TunerInput {
  const Ctor = audioContextCtor()
  if (!Ctor) throw new CaptureError('unsupported', 'this browser has no Web Audio')
  const ctx = new Ctor({ latencyHint: 'interactive' })
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = FRAME_SIZE
  analyser.smoothingTimeConstant = 0
  // a muted path to the destination keeps the graph pulled in every browser (old Safari skips orphans)
  const silent = ctx.createGain()
  silent.gain.value = 0
  source.connect(analyser)
  analyser.connect(silent)
  silent.connect(ctx.destination)

  // without a user activation left (iOS after the permission prompt) the context can stay suspended, and
  // Safari interrupts it for a call or Siri: resume it now, whenever it leaves "running", and on the next tap
  const unlock = () => {
    if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => undefined)
  }
  for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlock, { capture: true, passive: true })
  ctx.onstatechange = unlock
  unlock()

  let stopped = false
  return {
    sampleRate: ctx.sampleRate,
    read(into) {
      // a context that is not rendering keeps returning its last window: that is silence, not a held note
      if (ctx.state !== 'running') {
        into.fill(0)
        return 0
      }
      analyser.getFloatTimeDomainData(into)
      let sum = 0
      for (let i = 0; i < into.length; i++) sum += into[i] * into[i]
      return Math.sqrt(sum / into.length)
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlock, { capture: true })
      ctx.onstatechange = null
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => undefined)
    },
  }
}
