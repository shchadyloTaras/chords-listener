import { describe, expect, it, vi } from 'vitest'
import { YT_STATE, type YTPlayer } from './youtubeApi'
import { YouTubeSource } from './youtubeSource'
import type { SourceEvents } from './types'

function fakePlayer(state: number) {
  const player = {
    state,
    time: 0,
    playVideo: vi.fn(() => (player.state = YT_STATE.PLAYING)),
    pauseVideo: vi.fn(() => (player.state = YT_STATE.PAUSED)),
    // like the real API: seeking a video that is not paused starts it
    seekTo: vi.fn((t: number) => {
      player.time = t
      if (player.state !== YT_STATE.PAUSED) player.state = YT_STATE.PLAYING
    }),
    setPlaybackRate: vi.fn(),
    getPlaybackRate: () => 1,
    setVolume: vi.fn(),
    mute: vi.fn(),
    unMute: vi.fn(),
    getCurrentTime: () => player.time,
    getDuration: () => 200,
    getPlayerState: () => player.state,
    destroy: vi.fn(),
  }
  return player
}

function events(): SourceEvents {
  return { onPlay: vi.fn(), onPause: vi.fn(), onEnded: vi.fn(), onDuration: vi.fn(), onError: vi.fn() }
}

describe('YouTubeSource seeking', () => {
  it('does not start a cued video when the app seeks while paused', () => {
    const p = fakePlayer(YT_STATE.CUED)
    const src = new YouTubeSource(p as unknown as YTPlayer, events())
    src.seek(42.5)
    expect(p.seekTo).not.toHaveBeenCalled()
    expect(p.state).toBe(YT_STATE.CUED)
    expect(src.getTime()).toBe(42.5)
    expect(src.isPlaying()).toBe(false)
  })

  it('applies the remembered position when playback starts', () => {
    const p = fakePlayer(YT_STATE.UNSTARTED)
    const src = new YouTubeSource(p as unknown as YTPlayer, events())
    src.seek(30)
    src.play()
    expect(p.seekTo).toHaveBeenCalledWith(30, true)
    expect(p.playVideo).toHaveBeenCalled()
    expect(p.time).toBe(30)
  })

  it('jumps to the remembered position when started from the iframe controls', () => {
    const p = fakePlayer(YT_STATE.CUED)
    const ev = events()
    const src = new YouTubeSource(p as unknown as YTPlayer, ev)
    src.seek(12)
    p.state = YT_STATE.PLAYING
    src.handleState(YT_STATE.PLAYING)
    expect(p.seekTo).toHaveBeenCalledWith(12, true)
    expect(ev.onPlay).toHaveBeenCalled()
  })

  it('seeks directly once the video is paused or playing', () => {
    const p = fakePlayer(YT_STATE.PAUSED)
    const src = new YouTubeSource(p as unknown as YTPlayer, events())
    src.seek(5)
    expect(p.seekTo).toHaveBeenCalledWith(5, true)
    expect(p.state).toBe(YT_STATE.PAUSED)
    src.play()
    src.seek(9)
    expect(p.seekTo).toHaveBeenLastCalledWith(9, true)
  })
})
