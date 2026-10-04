import { t } from '../../i18n'
import { useApp, type PlayerController } from '../../store'
import type { Track } from '../../types'
import { AudioSource } from './sources/audioSource'
import { ClockSource } from './sources/clockSource'
import type { PlaybackSource, SourceEvents } from './sources/types'

/** Loop jump tolerance: only loop back when the playhead crossed loop.end just now. */
const LOOP_WINDOW = 0.75

/**
 * Owns playback for one loaded track.
 * - A base source (HTML audio, or a silent clock for the demo) is always present.
 * - An overlay source (the YouTube player) can be attached; playback is handed over
 *   keeping time and play state, so only one source ever plays.
 * - Registers a stable PlayerController in the store and pushes currentTime each frame.
 */
export class PlaybackEngine {
  private base: PlaybackSource
  private overlay: PlaybackSource | null = null
  private active: PlaybackSource | null = null
  private frame = 0
  private timer = 0
  private disposed = false
  private unsubscribe: () => void

  readonly controller: PlayerController = {
    play: () => this.active?.play(),
    pause: () => this.active?.pause(),
    seek: (time) => this.active?.seek(time),
    setRate: (rate) => this.active?.setRate(rate),
    setVolume: (volume) => this.active?.setVolume(volume),
    getTime: () => this.active?.getTime() ?? 0,
  }

  constructor(track: Track) {
    this.base = this.create((events) =>
      track.audioUrl
        ? new AudioSource(track.audioUrl, events, track.startOffset ?? 0)
        : new ClockSource(track.duration, events),
    )
    this.activate(this.base)
    useApp.getState().registerController(this.controller)

    this.unsubscribe = useApp.subscribe((s, prev) => {
      if (s.playbackRate !== prev.playbackRate) this.active?.setRate(s.playbackRate)
      if (s.volume !== prev.volume || s.muted !== prev.muted) this.active?.setVolume(s.muted ? 0 : s.volume)
    })
  }

  get activeKind() {
    return this.active?.kind ?? null
  }

  /** Builds a source whose events only count while it is the active one. */
  create<S extends PlaybackSource>(factory: (events: SourceEvents) => S): S {
    let source: S | null = null
    const isActive = () => !this.disposed && source !== null && source === this.active
    const events: SourceEvents = {
      onPlay: () => {
        if (!isActive()) return
        useApp.getState().setPlayback({ isPlaying: true })
        this.startLoop()
      },
      onPause: () => {
        if (!isActive() || !source) return
        this.stopLoop()
        useApp.getState().setPlayback({ isPlaying: false, currentTime: source.getTime() })
      },
      onEnded: () => {
        if (!isActive() || !source) return
        const { loop, setPlayback } = useApp.getState()
        if (loop && loop.end > loop.start) {
          source.seek(loop.start)
          source.play()
          return
        }
        this.stopLoop()
        const end = source.getDuration() || useApp.getState().duration
        setPlayback({ isPlaying: false, currentTime: end })
      },
      onDuration: (d) => {
        if (!isActive() || !source || source.kind === 'youtube') return
        if (Number.isFinite(d) && d > 0) useApp.getState().setPlayback({ duration: d })
      },
      onError: (code) => {
        if (!isActive() || !source) return
        const { toast } = useApp.getState()
        if (code === 'autoplay') toast(t('core.player.autoplayBlocked'), 'info')
        else if (source.kind === 'audio') toast(t('core.player.audioError'), 'error')
      },
    }
    source = factory(events)
    return source
  }

  private activate(next: PlaybackSource) {
    const prev = this.active
    if (prev === next) return
    const s = useApp.getState()
    const time = prev ? prev.getTime() : s.currentTime
    const wasPlaying = prev ? prev.isPlaying() : false
    this.active = next // switch first: prev's pause event is ignored
    prev?.pause()
    next.setRate(s.playbackRate)
    next.setVolume(s.muted ? 0 : s.volume)
    next.seek(time)
    s.setPlayback({ currentTime: time })
    if (wasPlaying) next.play()
    else {
      this.stopLoop()
      s.setPlayback({ isPlaying: false })
    }
  }

  /** Hand playback to the overlay (YouTube) once it is ready. */
  attachOverlay(source: PlaybackSource) {
    if (this.disposed) return
    this.overlay = source
    this.activate(source)
  }

  /** Return playback to the base audio (keeps time + play state). */
  detachOverlay(source: PlaybackSource) {
    if (this.overlay !== source) return
    if (!this.disposed) this.activate(this.base)
    this.overlay = null
    source.destroy()
  }

  // ---------------------------------------------------------- time loop

  private startLoop() {
    if (this.frame || this.timer) return
    this.tick()
  }

  private stopLoop() {
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.timer) window.clearTimeout(this.timer)
    this.frame = 0
    this.timer = 0
  }

  private tick = () => {
    this.frame = 0
    this.timer = 0
    const src = this.active
    if (!src || this.disposed) return
    const s = useApp.getState()
    if (!s.isPlaying) return
    let time = src.getTime()
    const loop = s.loop
    if (loop && loop.end > loop.start && time >= loop.end && time < loop.end + LOOP_WINDOW) {
      src.seek(loop.start)
      time = loop.start
    }
    if (Math.abs(time - s.currentTime) > 0.0005) s.setPlayback({ currentTime: time })
    // rAF pauses in background tabs; a timer keeps A-B loops working there.
    if (document.hidden) this.timer = window.setTimeout(this.tick, 100)
    else this.frame = requestAnimationFrame(this.tick)
  }

  destroy() {
    if (this.disposed) return
    this.stopLoop()
    this.unsubscribe()
    this.active?.pause()
    this.disposed = true
    this.overlay?.destroy()
    this.base.destroy()
    this.active = null
    const s = useApp.getState()
    if (s.controller === this.controller) s.registerController(null)
    s.setPlayback({ isPlaying: false })
  }
}
