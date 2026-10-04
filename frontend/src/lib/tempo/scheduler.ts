// Metronome lookahead scheduler (pure logic, no Web Audio): maps the player's media clock onto
// the audio clock and decides which beat clicks to schedule on each tick.
//
// The driver calls update() every ~25 ms with the audio-context time, the player's current time
// and rate. The scheduler keeps an anchor (audio time ↔ media time), corrects small drift
// smoothly, re-syncs on jumps (seek, loop wrap, rate change, new grid) and returns the clicks
// that fall inside the lookahead window. `cancel` tells the driver to silence clicks it already
// queued but that have not sounded yet.

import { lowerBound } from './analysis'

export interface SchedulerOptions {
  /** how far ahead clicks are queued, audio seconds (default 0.12) */
  lookahead?: number
  /** media-time error treated as a jump → re-sync (default 0.2 s) */
  jumpTolerance?: number
  /** a click whose time passed more than this is dropped instead of played late (default 0.03 s) */
  lateTolerance?: number
  /** share of small drift corrected per tick (default 0.15) */
  smoothing?: number
  /** how far past the loop end the player still wraps back (default 0.75 s, as the player engine) */
  loopWindow?: number
}

export interface SchedulerInput {
  /** player playing, not muted, metronome on */
  enabled: boolean
  /** AudioContext.currentTime */
  ctxTime: number
  /** player position, seconds */
  mediaTime: number
  /** playback rate (0.5..1.5) */
  rate: number
  /**
   * End of an active A-B loop: clicks at / after it are held while the player is about to wrap
   * (it jumps back once it crosses the end, within `loopWindow`), so the bar end never doubles
   * the downbeat at the loop start.
   */
  loopEnd?: number | null
}

export interface PlannedClick {
  /** audio-context time to start the click */
  at: number
  /** index into the beat grid */
  beat: number
  accent: boolean
}

export interface SchedulerOutput {
  /** drop every queued click that has not sounded yet */
  cancel: boolean
  clicks: PlannedClick[]
}

interface Anchor {
  ctx: number
  media: number
  rate: number
}

/** On a re-sync, a beat this recent (media seconds) still gets its click, played right away. */
const CATCH_UP = 0.03

export class MetronomeScheduler {
  private times: number[] = []
  private accents: boolean[] = []
  private anchor: Anchor | null = null
  private next = 0
  private dirty = true
  private readonly lookahead: number
  private readonly jumpTolerance: number
  private readonly lateTolerance: number
  private readonly smoothing: number
  private readonly loopWindow: number

  constructor(opts: SchedulerOptions = {}) {
    this.lookahead = opts.lookahead ?? 0.12
    this.jumpTolerance = opts.jumpTolerance ?? 0.2
    this.lateTolerance = opts.lateTolerance ?? 0.03
    this.smoothing = opts.smoothing ?? 0.15
    this.loopWindow = opts.loopWindow ?? 0.75
  }

  /** New beat grid (ascending times, accent = downbeat). Forces a re-sync on the next update. */
  setGrid(times: readonly number[], accents: readonly boolean[]): void {
    this.times = [...times]
    this.accents = this.times.map((_, i) => Boolean(accents[i]))
    this.dirty = true
  }

  /** Forget the clock mapping (e.g. the audio context was recreated). */
  reset(): void {
    this.anchor = null
    this.dirty = true
  }

  /** Media time at audio time `ctxTime` per the current anchor (NaN when not running). */
  mediaAt(ctxTime: number): number {
    const a = this.anchor
    return a ? a.media + (ctxTime - a.ctx) * a.rate : NaN
  }

  update(input: SchedulerInput): SchedulerOutput {
    const out: SchedulerOutput = { cancel: false, clicks: [] }
    const { ctxTime, mediaTime, rate } = input
    if (!input.enabled || !(rate > 0) || !Number.isFinite(mediaTime) || !this.times.length) {
      if (this.anchor) {
        out.cancel = true
        this.anchor = null
      }
      return out
    }

    let resync = !this.anchor || this.dirty || Math.abs(this.anchor.rate - rate) > 1e-6
    if (!resync && this.anchor) {
      const predicted = this.mediaAt(ctxTime)
      const err = mediaTime - predicted
      if (Math.abs(err) > this.jumpTolerance) resync = true
      else this.anchor = { ctx: ctxTime, media: predicted + err * this.smoothing, rate }
    }
    if (resync) {
      out.cancel = this.anchor !== null
      this.anchor = { ctx: ctxTime, media: mediaTime, rate }
      this.next = lowerBound(this.times, mediaTime - CATCH_UP)
      this.dirty = false
    }

    const a = this.anchor as Anchor
    const horizon = a.media + this.lookahead * a.rate
    const loopEnd = input.loopEnd
    const holdAt = loopEnd != null && mediaTime < loopEnd + this.loopWindow ? loopEnd - 0.005 : Infinity
    while (this.next < this.times.length) {
      const bt = this.times[this.next]
      if (bt > horizon || bt >= holdAt) break
      const at = a.ctx + (bt - a.media) / a.rate
      if (at >= ctxTime - this.lateTolerance) {
        out.clicks.push({ at: Math.max(ctxTime, at), beat: this.next, accent: this.accents[this.next] })
      }
      this.next++
    }
    return out
  }
}
