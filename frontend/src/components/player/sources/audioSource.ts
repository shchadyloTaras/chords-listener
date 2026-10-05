import { fetchAudioBlobUrl } from '../../../lib/api'
import type { PlaybackSource, SourceEvents } from './types'

/** What the owner of the audio wants to know / can do about it (e.g. the cloud copy kept on this device). */
export interface AudioMedia {
  /** the browser can play the file through (once): e.g. time to download a copy of it */
  onReady?(): void
  /**
   * The URL does not play: another one for the same audio (a fresh signed URL, a Blob URL — owned by the source
   * from then on), or null. Without it, a cross-origin http(s) URL is retried as a Blob (see tryFallback).
   */
  recover?(): Promise<string | null>
}

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
  private readonly media: AudioMedia

  constructor(url: string, events: SourceEvents, offset = 0, media: AudioMedia = {}) {
    this.events = events
    this.media = media
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
    let ready = false
    on('canplaythrough', () => {
      if (ready) return
      ready = true
      media.onReady?.()
    })
    on('error', () => {
      if (this.tryFallback(url)) return
      const code = el.error?.code
      events.onError(code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'unsupported' : 'media')
    })
  }

  private fallbackTried = false
  private blobUrl: string | null = null
  private dead = false

  /**
   * Once per source: the owner's other URL for the audio (AudioMedia.recover), else — audio from the user's
   * local server inside a page on another origin (GitHub Pages): some browsers (Safari) refuse to stream
   * http://localhost media there while fetch() works — play it from a Blob.
   */
  private tryFallback(url: string): boolean {
    if (this.fallbackTried || this.dead) return false
    let next: Promise<string | null>
    if (this.media.recover) next = this.media.recover()
    else {
      if (!/^https?:\/\//i.test(url)) return false
      try {
        if (new URL(url).origin === location.origin) return false
      } catch {
        return false
      }
      next = fetchAudioBlobUrl(url)
    }
    this.fallbackTried = true
    void next
      .catch(() => null)
      .then((nextUrl) => {
        const owned = nextUrl?.startsWith('blob:') ? nextUrl : null
        if (this.dead || !nextUrl) {
          if (owned) URL.revokeObjectURL(owned)
          else if (!this.dead) this.events.onError('media')
          return
        }
        this.blobUrl = owned
        const time = this.el.currentTime
        this.el.src = nextUrl
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
