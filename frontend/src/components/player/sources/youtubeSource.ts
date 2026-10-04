import { YT_STATE, type YTPlayer } from './youtubeApi'
import type { PlaybackSource, SourceEvents } from './types'

/**
 * Wraps a ready YT.Player. The API reports time coarsely, so between updates the
 * time is extrapolated from the last report to keep the chord highlight smooth.
 */
export class YouTubeSource implements PlaybackSource {
  readonly kind = 'youtube' as const
  private player: YTPlayer
  private events: SourceEvents
  private playing = false
  private rate = 1
  private lastRaw = -1
  private anchorTime = 0
  private anchorAt = 0
  /** Seek requested while the video has not started (or has ended); applied by play(). */
  private pendingSeek: number | null = null

  constructor(player: YTPlayer, events: SourceEvents) {
    this.player = player
    this.events = events
    const state = player.getPlayerState()
    this.playing = state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING
    const d = player.getDuration()
    if (d > 0) queueMicrotask(() => events.onDuration(d))
  }

  /** Forwarded from the player's onStateChange. */
  handleState(state: number) {
    if (state === YT_STATE.PLAYING) {
      this.playing = true
      if (this.pendingSeek !== null) {
        // started from the iframe's own controls: jump to the position the app shows
        const t = this.pendingSeek
        this.pendingSeek = null
        this.player.seekTo(t, true)
        this.reanchor(t)
      } else this.reanchor(this.safeRaw())
      this.events.onPlay()
    } else if (state === YT_STATE.PAUSED) {
      this.playing = false
      this.events.onPause()
    } else if (state === YT_STATE.ENDED) {
      this.playing = false
      this.events.onEnded()
    }
  }

  private safeRaw(): number {
    if (this.pendingSeek !== null) return this.pendingSeek
    try {
      return this.player.getCurrentTime() || 0
    } catch {
      return this.anchorTime
    }
  }

  private reanchor(t: number) {
    this.anchorTime = t
    this.anchorAt = performance.now()
    this.lastRaw = t
  }

  play() {
    this.playing = true
    if (this.pendingSeek !== null) {
      this.player.seekTo(this.pendingSeek, true)
      this.pendingSeek = null
    }
    this.player.playVideo()
  }

  pause() {
    this.playing = false
    this.player.pauseVideo()
  }

  seek(time: number) {
    const t = Math.max(0, time)
    // seekTo() starts playback unless the player is paused (unstarted / cued / ended videos
    // would start playing on their own), so a paused track only remembers the position.
    if (!this.playing && this.player.getPlayerState() !== YT_STATE.PAUSED) {
      this.pendingSeek = t
    } else {
      this.pendingSeek = null
      this.player.seekTo(t, true)
    }
    this.reanchor(t)
  }

  setRate(rate: number) {
    this.rate = rate
    this.player.setPlaybackRate(rate)
  }

  setVolume(volume: number) {
    if (volume <= 0) {
      this.player.mute()
    } else {
      this.player.unMute()
      this.player.setVolume(Math.round(volume * 100))
    }
  }

  getTime(): number {
    const raw = this.safeRaw()
    if (!this.playing || this.player.getPlayerState() !== YT_STATE.PLAYING) {
      this.reanchor(raw)
      return raw
    }
    const now = performance.now()
    const est = this.anchorTime + ((now - this.anchorAt) / 1000) * this.rate
    if (raw !== this.lastRaw) {
      // New report: accept it unless it would step slightly backwards (jitter).
      if (raw > est || est - raw > 0.3) {
        this.reanchor(raw)
        return raw
      }
      this.lastRaw = raw
    }
    return Math.min(est, raw + 0.5)
  }

  isPlaying() {
    return this.playing
  }

  getDuration() {
    try {
      return this.player.getDuration() || 0
    } catch {
      return 0
    }
  }

  destroy() {
    this.playing = false
  }
}
