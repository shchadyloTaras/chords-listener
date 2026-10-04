import { fetchAudioBlobUrl } from '../../../lib/api'
import type { PlaybackSource, SourceEvents } from './types'

/**
 * HTMLAudioElement-backed source (track.audioUrl, Range-capable endpoint).
 * `offset`: the audio file starts at this track time (a recording linked to a YouTube video and
 * started mid-video: audio time = track time − offset), so the track clock stays in video time.
 */
export class AudioSource implements PlaybackSource {
  readonly kind = 'audio' as const
  private el: HTMLAudioElement
  private events: SourceEvents
  private disposers: Array<() => void> = []
  private wantPlay = false
  private readonly offset: number

  constructor(url: string, events: SourceEvents, offset = 0) {
    this.events = events
    this.offset = Number.isFinite(offset) && offset > 0 ? offset : 0
    const el = new Audio()
    el.preload = 'metadata'
    el.preservesPitch = true
    el.src = url
    this.el = el

    const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => {
      el.addEventListener(type, fn)
      this.disposers.push(() => el.removeEventListener(type, fn))
    }
    on('play', () => events.onPlay())
    on('pause', () => {
      if (!el.ended) events.onPause()
    })
    on('ended', () => {
      this.wantPlay = false
      events.onEnded()
    })
    const pushDuration = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) events.onDuration(el.duration + this.offset)
    }
    on('loadedmetadata', pushDuration)
    on('durationchange', pushDuration)
    on('error', () => {
      if (this.tryBlobFallback(url)) return
      const code = el.error?.code
      events.onError(code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'unsupported' : 'media')
    })
  }

  private fallbackTried = false
  private blobUrl: string | null = null
  private dead = false

  /**
   * Audio from the user's local server inside a page on another origin (GitHub Pages): some browsers
   * (Safari) refuse to stream http://localhost media there while fetch() works — play it from a Blob.
   */
  private tryBlobFallback(url: string): boolean {
    if (this.fallbackTried || this.dead || !/^https?:\/\//i.test(url)) return false
    try {
      if (new URL(url).origin === location.origin) return false
    } catch {
      return false
    }
    this.fallbackTried = true
    void fetchAudioBlobUrl(url).then((blobUrl) => {
      if (this.dead || !blobUrl) {
        if (blobUrl) URL.revokeObjectURL(blobUrl)
        else if (!this.dead) this.events.onError('media')
        return
      }
      this.blobUrl = blobUrl
      const time = this.el.currentTime
      this.el.src = blobUrl
      if (time > 0) this.el.currentTime = time
      if (this.wantPlay) this.play()
    })
    return true
  }

  play() {
    this.wantPlay = true
    const p = this.el.play()
    p?.catch((err: unknown) => {
      // AbortError = interrupted by pause()/src change, not a real failure.
      if (err instanceof DOMException && err.name === 'AbortError') return
      this.wantPlay = false
      this.events.onPause()
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.events.onError('autoplay')
    })
  }

  pause() {
    this.wantPlay = false
    this.el.pause()
  }

  seek(time: number) {
    this.el.currentTime = Math.max(0, time - this.offset)
  }

  setRate(rate: number) {
    this.el.playbackRate = rate
    this.el.preservesPitch = true
  }

  setVolume(volume: number) {
    this.el.volume = Math.max(0, Math.min(1, volume))
  }

  getTime() {
    return this.el.currentTime + this.offset
  }

  isPlaying() {
    return this.wantPlay || (!this.el.paused && !this.el.ended)
  }

  getDuration() {
    return Number.isFinite(this.el.duration) ? this.el.duration + this.offset : 0
  }

  destroy() {
    this.wantPlay = false
    this.el.pause()
    this.disposers.forEach((d) => d())
    this.disposers = []
    this.el.removeAttribute('src')
    this.el.load()
    this.dead = true
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl)
    this.blobUrl = null
  }
}
