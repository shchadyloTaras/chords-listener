// Beat-synced metronome: Web Audio clicks scheduled ahead of time against the player's clock
// (currentTime × playbackRate) by MetronomeScheduler. Clicks stop on pause, re-sync after a seek /
// loop wrap / speed change, stay silent while the player is muted and accent the downbeats.

import { useEffect } from 'react'
import { MetronomeScheduler, type PulseGrid } from '../../../lib/tempo'
import { useApp } from '../../../store'

const TICK_MS = 25

type Ticker = { start(): void; stop(): void }

/**
 * A 25 ms ticker. Runs in a tiny worker when possible: worker timers are not throttled in
 * background tabs, so the click keeps going while the user looks at another tab.
 */
function createTicker(onTick: () => void): Ticker {
  let worker: Worker | null = null
  try {
    const src = 'let t=0;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}'
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
    worker = new Worker(url)
    URL.revokeObjectURL(url)
    worker.onmessage = onTick
  } catch {
    worker = null
  }
  let interval = 0
  return {
    start() {
      if (worker) worker.postMessage(TICK_MS)
      else if (!interval) interval = window.setInterval(onTick, TICK_MS)
    },
    stop() {
      if (worker) worker.postMessage(0)
      if (interval) window.clearInterval(interval)
      interval = 0
    },
  }
}

function sameTimes(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Highest metronome volume setting (2 = 200%). */
export const METRONOME_MAX_VOLUME = 2

/**
 * Perceptual curve up to 100%, then a steeper boost so the click cuts through loud mixes;
 * the limiter after the master gain keeps the boosted clicks from clipping.
 */
const gainFor = (v: number) => {
  const x = Math.max(0, Math.min(METRONOME_MAX_VOLUME, v))
  return x <= 1 ? x * x : 1 + (x - 1) * 3
}

function makeNoise(ctx: AudioContext): AudioBuffer | null {
  try {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.02), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return buf
  } catch {
    return null
  }
}

class MetronomeEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** 20 ms of white noise reused for every click's attack */
  private noise: AudioBuffer | null = null
  /** clicks go through a disposable bus so queued clicks can be silenced at once */
  private bus: GainNode | null = null
  private ticker: Ticker | null = null
  private running = false
  private lastResume = 0
  private readonly scheduler = new MetronomeScheduler()
  private times: number[] = []
  private accents: boolean[] = []
  /** clicks queued so far (for diagnostics / tests in the browser console) */
  clicks = 0

  setGrid(grid: PulseGrid): void {
    const accents = grid.pos.map((p) => p === 0)
    if (sameTimes(this.times, grid.times) && this.accents.every((a, i) => a === accents[i])) return
    this.times = grid.times
    this.accents = accents
    this.scheduler.setGrid(grid.times, accents)
  }

  /** Creates / resumes the audio context. Call from a user gesture (autoplay policy). */
  unlock(): void {
    const ctx = this.ensureContext()
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  }

  /** Starts / stops the ticker to match the store (metronome on + playing). */
  sync(): void {
    const s = useApp.getState()
    const want = s.metronome && s.isPlaying && Boolean(s.controller)
    if (want && !this.running) {
      this.unlock()
      if (!this.ctx) return
      this.ticker ??= createTicker(this.tick)
      this.running = true
      this.ticker.start()
      this.tick()
    } else if (!want && this.running) {
      this.running = false
      this.ticker?.stop()
      this.tick() // lets the scheduler cancel whatever is still queued
    }
  }

  setVolume(volume: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(gainFor(volume), this.ctx.currentTime, 0.015)
  }

  /** Stops clicking (track closed); the audio context is kept for the next track. */
  stop(): void {
    this.running = false
    this.ticker?.stop()
    this.scheduler.reset()
    this.flush()
  }

  /** A single click right now (used as feedback when the metronome is switched on). */
  preview(accent = true): void {
    const ctx = this.ctx
    if (ctx && ctx.state === 'running') this.click(ctx.currentTime + 0.01, accent)
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined
    if (!Ctor) return null
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' })
      const master = ctx.createGain()
      master.gain.value = gainFor(useApp.getState().metronomeVolume)
      // Fast limiter: loud settings get louder clicks instead of distortion.
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -3
      limiter.knee.value = 2
      limiter.ratio.value = 20
      limiter.attack.value = 0.0005
      limiter.release.value = 0.06
      master.connect(limiter)
      limiter.connect(ctx.destination)
      this.noise = makeNoise(ctx)
      this.ctx = ctx
      this.master = master
      this.bus = null
      this.flush()
      return ctx
    } catch {
      return null
    }
  }

  private tick = (): void => {
    const ctx = this.ctx
    if (!ctx) return
    const s = useApp.getState()
    let media = NaN
    try {
      media = s.controller ? s.controller.getTime() : NaN
    } catch {
      // player not ready
    }
    const enabled = this.running && s.metronome && s.isPlaying && !s.muted && ctx.state === 'running'
    if (this.running && ctx.state === 'suspended' && performance.now() - this.lastResume > 1000) {
      this.lastResume = performance.now()
      void ctx.resume().catch(() => undefined)
    }
    const loop = s.loop && s.loop.end > s.loop.start ? s.loop.end : null
    const plan = this.scheduler.update({ enabled, ctxTime: ctx.currentTime, mediaTime: media, rate: s.playbackRate, loopEnd: loop })
    if (plan.cancel) this.flush()
    for (const c of plan.clicks) this.click(c.at, c.accent)
  }

  /** Silences every queued click by swapping the output bus. */
  private flush(): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    this.bus?.disconnect()
    this.bus = ctx.createGain()
    this.bus.connect(this.master)
  }

  /**
   * A short woodblock-like "tick": a bright pitched body plus a noise transient for the attack,
   * so it stays audible over the music. Higher and louder on the downbeat.
   */
  private click(at: number, accent: boolean): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    const len = accent ? 0.08 : 0.06
    const peak = accent ? 1 : 0.75

    const osc = ctx.createOscillator()
    const tone = ctx.createBiquadFilter()
    const env = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(accent ? 1760 : 1175, at)
    osc.frequency.exponentialRampToValueAtTime(accent ? 1320 : 880, at + 0.04)
    tone.type = 'lowpass'
    tone.frequency.value = 6000
    env.gain.setValueAtTime(0.0001, at)
    env.gain.exponentialRampToValueAtTime(peak * 0.7, at + 0.0015)
    env.gain.exponentialRampToValueAtTime(0.0001, at + len)
    osc.connect(tone)
    tone.connect(env)
    env.connect(bus)
    osc.start(at)
    osc.stop(at + len + 0.01)

    const nodes: AudioNode[] = [osc, tone, env]
    if (this.noise) {
      const hiss = ctx.createBufferSource()
      const hp = ctx.createBiquadFilter()
      const henv = ctx.createGain()
      hiss.buffer = this.noise
      hp.type = 'highpass'
      hp.frequency.value = 2500
      henv.gain.setValueAtTime(peak * 0.9, at)
      henv.gain.exponentialRampToValueAtTime(0.0001, at + 0.012)
      hiss.connect(hp)
      hp.connect(henv)
      henv.connect(bus)
      hiss.start(at)
      hiss.stop(at + 0.015)
      nodes.push(hiss, hp, henv)
    }
    osc.onended = () => {
      for (const n of nodes) n.disconnect()
    }
    this.clicks++
  }
}

let engine: MetronomeEngine | null = null

export function getMetronome(): MetronomeEngine {
  engine ??= new MetronomeEngine()
  return engine
}

/** Turns the metronome on / off (call from the user gesture so audio can start). */
export function toggleMetronome(on = !useApp.getState().metronome): boolean {
  const m = getMetronome()
  if (on) m.unlock()
  useApp.getState().setSetting('metronome', on)
  if (on && !useApp.getState().isPlaying && !useApp.getState().muted) m.preview()
  return on
}

/**
 * Drives the metronome for the loaded track: feeds it the pulse grid and follows the store
 * (on/off, play/pause, volume, mute). Mount once inside the chord workspace.
 */
export function useMetronome(grid: PulseGrid): void {
  useEffect(() => {
    getMetronome().setGrid(grid)
  }, [grid])

  useEffect(() => {
    const m = getMetronome()
    m.sync()
    const unsub = useApp.subscribe((s, p) => {
      if (s.metronome !== p.metronome || s.isPlaying !== p.isPlaying || s.controller !== p.controller) m.sync()
      if (s.metronomeVolume !== p.metronomeVolume) m.setVolume(s.metronomeVolume)
    })
    // Browsers only start audio after a gesture: piggy-back on the first one (e.g. pressing play).
    const onGesture = () => {
      if (useApp.getState().metronome) m.unlock()
    }
    window.addEventListener('pointerdown', onGesture, true)
    window.addEventListener('keydown', onGesture, true)
    return () => {
      unsub()
      window.removeEventListener('pointerdown', onGesture, true)
      window.removeEventListener('keydown', onGesture, true)
      m.stop()
    }
  }, [])
}
