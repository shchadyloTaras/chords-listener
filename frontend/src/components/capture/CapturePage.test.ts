// @vitest-environment jsdom
// The capture page keeps its player: the `?t=` it was opened with is read once, so the same video opened again with
// another `t` (back / forward between `?t=` entries, the video pasted again, a blocked-fragment toast) neither
// recreates the player - which would cut a recording off from its video - nor moves the "start from" offer.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../store'
import type { YTPlayer, YTPlayerOptions } from '../player/sources/youtubeApi'
import { CapturePage } from './CapturePage'

class FakePlayer {
  static made: FakePlayer[] = []
  destroyed = false
  opts: YTPlayerOptions
  constructor(_el: HTMLElement, opts: YTPlayerOptions) {
    this.opts = opts
    FakePlayer.made.push(this)
  }
  getCurrentTime = () => playerTime
  getDuration = () => 213
  getVideoData = () => ({ title: 'A song' })
  destroy() {
    this.destroyed = true
  }
}

const VIDEO = 'dQw4w9WgXcQ'
/** where the fake video is: 0 = it has not played yet, so the page offers the start it was opened with */
let playerTime = 0
let root: Root
let host: HTMLDivElement

function render(start: number | null): void {
  act(() => root.render(createElement(CapturePage, { videoId: VIDEO, blocked: false, start })))
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  window.location.hash = `#/listen/youtube/${VIDEO}?t=72`
  // a desktop browser that can hear a tab: the page offers "start from"
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getDisplayMedia: () => {}, getSupportedConstraints: () => ({ suppressLocalAudioPlayback: true }) },
    configurable: true,
  })
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  FakePlayer.made = []
  playerTime = 0
  // before the page mounts: its "where is the video" poll must run on these timers
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  ;(window as { YT?: unknown }).YT = { Player: FakePlayer }
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  render(72)
  await act(async () => {}) // the API loader resolves
})

afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  host.remove()
  delete (window as { YT?: unknown }).YT
  delete (navigator as { mediaDevices?: unknown }).mediaDevices
})

describe('the capture page player', () => {
  it('starts the video at the `?t=` the page was opened with', () => {
    expect(FakePlayer.made).toHaveLength(1)
    expect(FakePlayer.made[0]!.opts.playerVars?.start).toBe(72)
  })

  it('is not recreated when the same video is opened with another `t`', async () => {
    render(90)
    await act(async () => {})
    render(null)
    await act(async () => {})
    expect(FakePlayer.made).toHaveLength(1)
    expect(FakePlayer.made[0]!.destroyed).toBe(false)
  })

  const ready = () => {
    const player = FakePlayer.made[FakePlayer.made.length - 1]! // the page's player, whichever one it is by now
    act(() => player.opts.events?.onReady?.({ target: player as unknown as YTPlayer }))
  }
  const poll = () =>
    act(() => {
      vi.advanceTimersByTime(600)
    })

  it('offers where the video is once it has played (the poll runs)', async () => {
    ready()
    poll()
    expect(host.textContent).toContain('1:12') // not played: the start the page was opened with
    playerTime = 100
    poll()
    expect(host.textContent).toContain('1:40')
  })

  it('keeps offering the start it was opened with, not a later `t`', async () => {
    ready()
    playerTime = 100
    poll()
    expect(host.textContent).toContain('1:40')
    playerTime = 0 // back at the beginning: the offer falls back to the start the page was opened with
    render(90)
    await act(async () => {})
    ready()
    poll()
    expect(host.textContent).toContain('1:12')
    expect(host.textContent).not.toContain('1:30')
  })
})
