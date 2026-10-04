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

/** Perceptual volume curve; the click is short, so allow it to be fairly loud at the top. */
const gainFor = (v: number) => Math.max(0, Math.min(1, v)) ** 2 * 0.9

class MetronomeEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
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
      master.connect(ctx.destination)
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

  /** A short pitched "tick": higher and louder on the downbeat. */
  private click(at: number, accent: boolean): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(accent ? 1760 : 1175, at)
    osc.frequency.exponentialRampToValueAtTime(accent ? 1320 : 880, at + 0.04)
    const peak = accent ? 1 : 0.6
    const len = accent ? 0.07 : 0.05
    env.gain.setValueAtTime(0.0001, at)
    env.gain.exponentialRampToValueAtTime(peak, at + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, at + len)
    osc.connect(env)
    env.connect(bus)
    osc.start(at)
    osc.stop(at + len + 0.01)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
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
