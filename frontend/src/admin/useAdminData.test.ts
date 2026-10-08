// @vitest-environment jsdom
// AC-02: the admin page never polls — data loads when the screen opens, when the tab is returned to after at
// least a minute, or on «Оновити». An idle open tab sends nothing, so the sleeping cloud server may sleep.
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REFRESH_AFTER_MS, useAdminData, type AdminData } from './useAdminData'

let root: Root
let host: HTMLDivElement
let latest: AdminData<number>
let calls: number

const flush = () => act(async () => undefined)

function Probe({ load, keys }: { load: (signal: AbortSignal) => Promise<number>; keys: string }) {
  const data = useAdminData(load, keys)
  useEffect(() => {
    latest = data
  })
  return null
}

function mount(load: (signal: AbortSignal) => Promise<number> = async () => ++calls, keys = 'k') {
  return act(async () => {
    root.render(createElement(Probe, { load, keys }))
  })
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  calls = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  setVisibility('visible')
})

describe('refresh policy', () => {
  it('loads once on mount and exposes the data', async () => {
    await mount()
    expect(calls).toBe(1)
    expect(latest.data).toBe(1)
    expect(latest.error).toBeNull()
    expect(latest.loading).toBe(false)
  })

  it('sends nothing while the tab idles for 30 minutes, and sets no timer', async () => {
    await mount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000)
    })
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not refetch on tab return within a minute, but does after a minute', async () => {
    await mount()
    setVisibility('hidden')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    setVisibility('visible')
    await flush()
    expect(calls).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_AFTER_MS - 30_000 + 1_000)
    })
    setVisibility('hidden')
    setVisibility('visible')
    await flush()
    expect(calls).toBe(2)
    expect(latest.data).toBe(2)
  })

  it('refetches at 61 s since the load but not at 59 s', async () => {
    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    setVisibility('visible')
    await flush()
    expect(calls).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    setVisibility('visible')
    await flush()
    expect(calls).toBe(2)
  })

  it('ignores the tab being hidden', async () => {
    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    setVisibility('hidden')
    await flush()
    expect(calls).toBe(1)
  })

  it('refreshes on demand at any time', async () => {
    await mount()
    await act(async () => latest.refresh())
    await act(async () => latest.refresh())
    expect(calls).toBe(3)
    expect(latest.data).toBe(3)
  })

  it('loads again when the key changes (a new search or filter), not otherwise', async () => {
    const load = async () => ++calls
    await mount(load, 'a')
    await mount(load, 'a')
    expect(calls).toBe(1)
    await mount(load, 'b')
    expect(calls).toBe(2)
  })

  it('keeps the previous data when a refresh fails, and clears the error when the next one works', async () => {
    let fail = false
    const load = async () => {
      if (fail) throw new Error('nope')
      return ++calls
    }
    await mount(load)
    fail = true
    await act(async () => latest.refresh())
    expect(latest.error).toBeInstanceOf(Error)
    expect(latest.data).toBe(1)
    fail = false
    await act(async () => latest.refresh())
    expect(latest.error).toBeNull()
    expect(latest.data).toBe(2)
  })

  it('drops the answer of a superseded load', async () => {
    const resolvers: Array<(n: number) => void> = []
    const load = () => new Promise<number>((resolve) => resolvers.push(resolve))
    await mount(load)
    await act(async () => latest.refresh())
    expect(resolvers).toHaveLength(2)
    await act(async () => resolvers[1](2))
    await act(async () => resolvers[0](1))
    expect(latest.data).toBe(2)
  })

  it('stops listening to the tab when unmounted', async () => {
    await mount()
    act(() => root.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    setVisibility('visible')
    expect(calls).toBe(1)
    root = createRoot(host)
  })
})
