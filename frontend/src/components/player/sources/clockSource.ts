import type { PlaybackSource, SourceEvents } from './types'

/** Silent timer-based "player" for tracks without audio (the #/demo fixture). */
export class ClockSource implements PlaybackSource {
  readonly kind = 'clock' as const
  private base = 0
  private startedAt: number | null = null
  private rate = 1
  private endTimer: number | null = null
  private duration: number
  private events: SourceEvents

  constructor(duration: number, events: SourceEvents) {
    this.duration = duration
    this.events = events
    queueMicrotask(() => events.onDuration(duration))
  }

  private now() {
    return performance.now()
  }

  private raw(): number {
    if (this.startedAt === null) return this.base
    return this.base + ((this.now() - this.startedAt) / 1000) * this.rate
  }

  private clearEnd() {
    if (this.endTimer !== null) window.clearTimeout(this.endTimer)
    this.endTimer = null
  }

  private scheduleEnd() {
    this.clearEnd()
    if (this.startedAt === null) return
    const ms = ((this.duration - this.raw()) / this.rate) * 1000
    this.endTimer = window.setTimeout(() => {
      this.base = this.duration
      this.startedAt = null
      this.endTimer = null
      this.events.onEnded()
    }, Math.max(0, ms))
  }

  play() {
    if (this.startedAt !== null) return
    if (this.base >= this.duration - 0.05) this.base = 0
    this.startedAt = this.now()
    this.scheduleEnd()
    this.events.onPlay()
  }

  pause() {
    if (this.startedAt === null) return
    this.base = Math.min(this.duration, this.raw())
    this.startedAt = null
    this.clearEnd()
    this.events.onPause()
  }

  seek(time: number) {
    this.base = Math.max(0, Math.min(this.duration, time))
    if (this.startedAt !== null) {
      this.startedAt = this.now()
      this.scheduleEnd()
    }
  }

  setRate(rate: number) {
    if (this.startedAt !== null) {
      this.base = this.raw()
      this.startedAt = this.now()
    }
    this.rate = rate
    this.scheduleEnd()
  }

  setVolume() {
    /* silent */
  }

  getTime() {
    return Math.min(this.duration, this.raw())
  }

  isPlaying() {
    return this.startedAt !== null
  }

  getDuration() {
    return this.duration
  }

  destroy() {
    this.clearEnd()
    this.startedAt = null
  }
}
