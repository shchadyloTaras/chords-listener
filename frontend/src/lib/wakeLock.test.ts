// @vitest-environment jsdom
// The screen stays on while the app is open and visible (settings.keepAwake): a fake navigator.wakeLock that,
// like the browser, refuses a hidden page and drops every lock when the page is hidden.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepScreenAwake, useKeepScreenAwake } from './wakeLock'

class FakeSentinel extends EventTarget {
  readonly type = 'screen'
  released = false
  onrelease = null
  /** called by the app */
  release = vi.fn(async () => this.drop())
  /** the browser (or the app) lets the lock go */
  drop() {
    if (this.released) return
    this.released = true
    this.dispatchEvent(new Event('release'))
  }
}

let visibility: DocumentVisibilityState = 'visible'
/** sentinels handed out (resolved requests) */
let sentinels: FakeSentinel[] = []
/** reject the next n requests (battery saver, no user activation, …) */
let refuse = 0
/** keep requests pending until `settle()` */
let hold = false
let pending: Array<() => void> = []

const request = vi.fn((type: string): Promise<FakeSentinel> => {
  expect(type).toBe('screen')
  if (refuse > 0) {
    refuse--
    return Promise.reject(new DOMException('Wake Lock permission request denied', 'NotAllowedError'))
  }
  if (visibility !== 'visible') return Promise.reject(new DOMException('The document is hidden', 'NotAllowedError'))
  const s = new FakeSentinel()
  if (!hold) {
    sentinels.push(s)
    return Promise.resolve(s)
  }
  return new Promise((resolve) =>
    pending.push(() => {
      sentinels.push(s)
      resolve(s)
    }),
  )
})

const active = () => sentinels.filter((s) => !s.released)
const tick = () => act(() => new Promise<void>((r) => setTimeout(r, 0)))
async function settle() {
  const run = pending
  pending = []
  for (const r of run) r()
  await tick()
}
function setVisible(v: boolean) {
  visibility = v ? 'visible' : 'hidden'
  if (!v) for (const s of active()) s.drop() // the browser releases the lock of a hidden page
  document.dispatchEvent(new Event('visibilitychange'))
}
const tap = () => window.dispatchEvent(new Event('pointerup'))
const key = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))

let stops: Array<() => void> = []
const start = () => {
  const stop = keepScreenAwake()
  stops.push(stop)
  return stop
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  visibility = 'visible'
  sentinels = []
  refuse = 0
  hold = false
  pending = []
  request.mockClear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } })
  for (const level of ['error', 'warn', 'log', 'info'] as const) vi.spyOn(console, level)
})

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
  for (const level of ['error', 'warn', 'log', 'info'] as const) expect(console[level]).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  delete (navigator as { wakeLock?: unknown }).wakeLock
})

describe('keepScreenAwake', () => {
  it('takes the lock while the page is visible', async () => {
    start()
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    expect(active()).toHaveLength(1)
  })

  it('asks for nothing while the page is hidden, and takes the lock once it is shown', async () => {
    visibility = 'hidden'
    start()
    await tick()
    expect(request).not.toHaveBeenCalled()
    setVisible(true)
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    expect(active()).toHaveLength(1)
  })

  it('takes it again after the page was hidden (the browser drops it) and shown', async () => {
    start()
    await tick()
    setVisible(false)
    await tick()
    expect(active()).toHaveLength(0)
    expect(request).toHaveBeenCalledTimes(1)
    setVisible(true)
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(active()).toHaveLength(1)
  })

  it('takes it again on pageshow (a page restored from the back-forward cache)', async () => {
    start()
    await tick()
    active()[0].drop()
    window.dispatchEvent(new Event('pageshow'))
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(active()).toHaveLength(1)
  })

  it('does not ask again while it holds the lock', async () => {
    start()
    await tick()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    tap()
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when stopped and then ignores the page', async () => {
    const stop = start()
    await tick()
    const [s] = active()
    stop()
    expect(s.release).toHaveBeenCalledTimes(1)
    expect(active()).toHaveLength(0)
    setVisible(false)
    setVisible(true)
    window.dispatchEvent(new Event('pageshow'))
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    expect(() => stop()).not.toThrow()
  })

  it('releases a lock that arrives after it was stopped', async () => {
    hold = true
    const stop = start()
    await tick()
    stop()
    await settle()
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0].release).toHaveBeenCalledTimes(1)
    expect(active()).toHaveLength(0)
  })

  it('releases a lock that arrives while the page is hidden, and asks again when it is shown', async () => {
    hold = true
    start()
    await tick()
    setVisible(false)
    await settle()
    expect(active()).toHaveLength(0)
    hold = false
    setVisible(true)
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(active()).toHaveLength(1)
  })

  it('never holds two locks when the page flips while a request is in flight', async () => {
    hold = true
    start()
    await tick()
    for (let i = 0; i < 3; i++) {
      setVisible(false)
      setVisible(true)
      window.dispatchEvent(new Event('pageshow'))
    }
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    await settle()
    await settle()
    expect(active()).toHaveLength(1)
    expect(request.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('a refused request is tried again on the next tap, only once', async () => {
    refuse = 2
    start()
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    expect(active()).toHaveLength(0)
    tap()
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    tap()
    key()
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(active()).toHaveLength(0)
  })

  it('the retry takes the lock when the browser allows it on a tap', async () => {
    refuse = 1
    start()
    await tick()
    tap()
    tap()
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(active()).toHaveLength(1)
  })

  it('a key press works as the retry too', async () => {
    refuse = 1
    start()
    await tick()
    key()
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(active()).toHaveLength(1)
  })

  it('a refusal after the page was shown again gets its own retry', async () => {
    refuse = 2
    start()
    await tick()
    tap()
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    setVisible(false)
    setVisible(true)
    await tick()
    expect(request).toHaveBeenCalledTimes(3)
    expect(active()).toHaveLength(1)
  })

  it('no retry after it was stopped', async () => {
    refuse = 1
    const stop = start()
    await tick()
    stop()
    tap()
    key()
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('survives a request that throws instead of rejecting', async () => {
    request.mockImplementationOnce(() => {
      throw new TypeError('boom')
    })
    expect(() => start()).not.toThrow()
    await tick()
    tap()
    await tick()
    expect(active()).toHaveLength(1)
  })

  it('does nothing in a browser without the Wake Lock API', async () => {
    delete (navigator as { wakeLock?: unknown }).wakeLock
    let stop: () => void = () => {}
    expect(() => (stop = start())).not.toThrow()
    setVisible(false)
    setVisible(true)
    tap()
    await tick()
    expect(() => stop()).not.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('useKeepScreenAwake', () => {
  let root: Root | null = null
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    host.remove()
  })

  function Probe({ enabled }: { enabled: boolean }) {
    useKeepScreenAwake(enabled)
    return null
  }
  const render = (enabled: boolean) => act(() => root!.render(createElement(Probe, { enabled })))

  it('holds the lock while enabled, lets it go when turned off and on unmount', async () => {
    render(true)
    await tick()
    expect(active()).toHaveLength(1)
    render(false)
    await tick()
    expect(active()).toHaveLength(0)
    render(true)
    await tick()
    expect(active()).toHaveLength(1)
    act(() => root!.unmount())
    root = null
    await tick()
    expect(active()).toHaveLength(0)
    setVisible(false)
    setVisible(true)
    await tick()
    expect(active()).toHaveLength(0)
  })

  it('asks for nothing when off', async () => {
    render(false)
    await tick()
    expect(request).not.toHaveBeenCalled()
  })
})
