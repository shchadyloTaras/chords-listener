// Minimal typings + loader for the YouTube IFrame Player API.

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const

export interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setPlaybackRate(rate: number): void
  getPlaybackRate(): number
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  destroy(): void
}

export interface YTPlayerOptions {
  videoId: string
  width?: string | number
  height?: string | number
  host?: string
  playerVars?: Record<string, string | number>
  events?: {
    onReady?: (e: { target: YTPlayer }) => void
    onStateChange?: (e: { data: number; target: YTPlayer }) => void
    onError?: (e: { data: number; target: YTPlayer }) => void
  }
}

export interface YTNamespace {
  Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace & { loaded?: number }
    onYouTubeIframeAPIReady?: () => void
  }
}

let loading: Promise<YTNamespace> | null = null

/** Loads https://www.youtube.com/iframe_api once. Rejects on network failure / timeout. */
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (loading) return loading
  loading = new Promise<YTNamespace>((resolve, reject) => {
    const timer = window.setTimeout(() => fail(new Error('YouTube API timeout')), timeoutMs)
    const prevReady = window.onYouTubeIframeAPIReady
    const fail = (err: Error) => {
      window.clearTimeout(timer)
      loading = null
      reject(err)
    }
    window.onYouTubeIframeAPIReady = () => {
      prevReady?.()
      window.clearTimeout(timer)
      if (window.YT?.Player) resolve(window.YT)
      else fail(new Error('YouTube API missing'))
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      script.remove()
      fail(new Error('YouTube API failed to load'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** Errors meaning "the owner does not allow embedding" (plus 153: missing referrer / embed config). */
export function isEmbedBlockedError(code: number): boolean {
  return code === 101 || code === 150 || code === 153
}
