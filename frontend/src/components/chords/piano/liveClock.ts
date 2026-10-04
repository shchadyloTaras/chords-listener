// Media time for the live piano, every animation frame.
//
// Players report time coarsely (YouTube a few times per second, <audio> in steps on some browsers),
// so while playing the clock extrapolates with performance.now() × playbackRate from an anchor and
// folds each fresh reading in smoothly: small errors are corrected gradually and never move the time
// backwards; a jump (seek, loop, stall) re-anchors at once. Pause, play and rate changes take effect
// on the frame they are seen. After play / a jump the clock holds still until the player's time
// actually moves (audio output starts some ms after play(); a seek may buffer first).

export interface ClockReading {
  /** performance.now(), ms */
  now: number
  /** the player's time, s */
  media: number
  playing: boolean
  rate: number
}

export interface ClockOptions {
  /** share of a fresh reading's error applied per reading (0..1) */
  gain: number
  /** readings this far ahead of the estimate (s) are jumps, not jitter */
  jumpAhead: number
  /** …or this far behind it (s) */
  jumpBehind: number
}

export const DEFAULT_CLOCK: ClockOptions = { gain: 0.2, jumpAhead: 0.12, jumpBehind: 0.05 }

export class LiveClock {
  private readonly opts: ClockOptions
  private playing = false
  private rate = 1
  private anchorMedia = 0
  private anchorAt = 0
  private lastMedia = Number.NaN
  private lastOut = 0
  /** waiting for the player's time to move away from this value (after play / a jump) */
  private holding: number | null = null
  /** the previous output was a discontinuity (seek / loop / start), for the renderer's glow logic */
  jumped = true

  constructor(opts: Partial<ClockOptions> = {}) {
    this.opts = { ...DEFAULT_CLOCK, ...opts }
  }

  private predict(now: number): number {
    return this.anchorMedia + ((now - this.anchorAt) / 1000) * this.rate
  }

  private anchor(media: number, now: number): number {
    this.anchorMedia = media
    this.anchorAt = now
    this.lastOut = media
    this.jumped = true
    return media
  }

  /** Smoothed media time (s) at `r.now`. */
  update(r: ClockReading): number {
    const media = Number.isFinite(r.media) ? r.media : 0
    const rate = Number.isFinite(r.rate) && r.rate > 0 ? r.rate : 1
    this.jumped = false
    if (!r.playing) {
      // paused: the player's time is exact
      this.playing = false
      this.holding = null
      this.lastMedia = media
      return this.anchor(media, r.now)
    }
    if (!this.playing) {
      this.playing = true
      this.rate = rate
      this.lastMedia = media
      this.holding = media
      return this.anchor(media, r.now)
    }
    if (this.holding !== null) {
      this.rate = rate
      this.lastMedia = media
      if (media === this.holding) {
        this.anchorMedia = media
        this.anchorAt = r.now
        this.lastOut = media
        return media
      }
      // moving: extrapolate from this reading on
      this.holding = null
      this.anchorMedia = media
      this.anchorAt = r.now
      this.lastOut = media
      return media
    }
    if (rate !== this.rate) {
      // keep the time continuous, change the speed from now on
      const at = Math.max(this.lastOut, this.predict(r.now))
      this.rate = rate
      this.anchorMedia = at
      this.anchorAt = r.now
    }
    let estimate = this.predict(r.now)
    if (media !== this.lastMedia) {
      this.lastMedia = media
      const err = media - estimate
      if (err > this.opts.jumpAhead || err < -this.opts.jumpBehind) {
        this.holding = media
        return this.anchor(media, r.now)
      }
      estimate += err * this.opts.gain
      this.anchorMedia = estimate
      this.anchorAt = r.now
    }
    // corrections may slow the clock down for a moment, never run it backwards
    const out = Math.max(this.lastOut, estimate)
    this.lastOut = out
    return out
  }

  /** Forget the anchor (track change). */
  reset(): void {
    this.playing = false
    this.holding = null
    this.lastMedia = Number.NaN
    this.lastOut = 0
    this.jumped = true
  }
}

/**
 * Frame-to-photon lead: a frame drawn at `now` reaches the screen about one refresh later, so the
 * piano shows the music of that moment. Tracks the refresh interval from rAF timestamps.
 */
export class FrameLead {
  private last = 0
  private interval = 1000 / 60

  /** Feed each rAF timestamp; returns the lead in ms. */
  tick(now: number): number {
    if (this.last) {
      const dt = now - this.last
      if (dt > 4 && dt < 50) this.interval += (dt - this.interval) * 0.1
    }
    this.last = now
    return this.ms
  }

  /** after an idle period the next delta is not a frame interval */
  pause(): void {
    this.last = 0
  }

  get ms(): number {
    return Math.min(34, Math.max(6, this.interval))
  }
}
