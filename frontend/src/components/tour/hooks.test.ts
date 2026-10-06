// @vitest-environment jsdom
// Auto-start: a screen reports readiness with useTourTrigger; its tour opens ~500 ms after the page is quiet,
// once per device and one at a time. Flags and blocks come and go with the components that report them.
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTourSeen, markTourSeen } from '../../lib/tour/storage'
import type { TourId } from '../../lib/tour/tours'
import { useApp } from '../../store'
import { useTourBlock, useTourFlags, useTourTrigger } from './hooks'
import { closeTour, useTourStore } from './tourStore'

function Trigger({ id, ready, recording = false }: { id: TourId; ready: boolean; recording?: boolean }) {
  useTourTrigger(id, ready, recording)
  return null
}
function Block() {
  useTourBlock(true)
  return null
}
function Flags() {
  useTourFlags({ libraryEmpty: true })
  return null
}

let root: Root
let host: HTMLDivElement
const made: HTMLElement[] = []
function add(html: string): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  const el = box.firstElementChild as HTMLElement
  document.body.append(el)
  made.push(el)
  return el
}

const render = (...nodes: ReactNode[]) => act(() => root.render(createElement(Fragment, null, ...nodes)))
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const running = () => useTourStore.getState().active?.tourId ?? null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  localStorage.clear()
  window.location.hash = '#/'
  useApp.setState({ isPlaying: false })
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  made.splice(0).forEach((el) => el.remove())
  useTourStore.setState({ active: null, queue: [] })
  vi.useRealTimers()
})

describe('auto-start', () => {
  it('opens 500 ms after the screen is ready', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(499)
    expect(running()).toBeNull()
    wait(1)
    expect(running()).toBe('home')
  })

  it('waits for the screen to be ready', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: false }))
    wait(2000)
    expect(running()).toBeNull()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(500)
    expect(running()).toBe('home')
  })

  it.each([
    [
      'an open dialog',
      () => {
        const el = add('<div aria-modal="true"></div>')
        return () => el.remove()
      },
    ],
    [
      'an open menu',
      () => {
        const el = add('<div role="menu"></div>')
        return () => el.remove()
      },
    ],
    [
      'an open panel',
      () => {
        const el = add('<button aria-expanded="true"></button>')
        return () => el.remove()
      },
    ],
    [
      'text being typed',
      () => {
        const input = add('<input type="text" value="Am" />') as HTMLInputElement
        input.focus()
        return () => input.blur()
      },
    ],
    [
      'the song playing',
      () => {
        useApp.setState({ isPlaying: true })
        return () => useApp.setState({ isPlaying: false })
      },
    ],
    [
      'a hidden page',
      () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        return () => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      },
    ],
  ] as const)('holds back while %s, then opens ~500 ms after it clears', (_, setup) => {
    const clear = setup()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(2000)
    expect(running()).toBeNull()
    clear()
    wait(750)
    expect(running()).toBe('home')
  })

  it('holds back while a recording runs', () => {
    render(createElement(Trigger, { key: 'l', id: 'listen', ready: true, recording: true }))
    wait(2000)
    expect(running()).toBeNull()
    render(createElement(Trigger, { key: 'l', id: 'listen', ready: true, recording: false }))
    wait(500)
    expect(running()).toBe('listen')
  })

  it('an empty, autofocused link field does not hold it back', () => {
    const input = add('<input type="url" />') as HTMLInputElement
    input.focus()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(500)
    expect(running()).toBe('home')
  })

  it('a component that blocks (a link on its way) holds it back until it lets go', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }), createElement(Block, { key: 'b' }))
    wait(2000)
    expect(running()).toBeNull()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(750)
    expect(running()).toBe('home')
  })

  it('never opens a tour this device has seen', () => {
    markTourSeen('home')
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(3000)
    expect(running()).toBeNull()
  })

  it('two tours due at once: one opens, the other ~500 ms after it closes, and «Пропустити» does not mark it seen', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }), createElement(Trigger, { key: 'l', id: 'listen', ready: true }))
    wait(500)
    expect(running()).toBe('home')
    wait(2000)
    expect(running()).toBe('home')
    act(() => closeTour('skip'))
    expect(isTourSeen('home')).toBe(true)
    expect(isTourSeen('listen')).toBe(false)
    wait(250)
    expect(running()).toBeNull()
    wait(750)
    expect(running()).toBe('listen')
  })
})

describe('flags and blocks', () => {
  it('a screen’s flags merge into the store and leave with it', () => {
    render(createElement(Flags, { key: 'f' }))
    expect(useTourStore.getState().flags.libraryEmpty).toBe(true)
    render()
    expect(useTourStore.getState().flags.libraryEmpty).toBeUndefined()
  })

  it('a block is held while its component is mounted', () => {
    render(createElement(Block, { key: 'b' }))
    expect(Object.keys(useTourStore.getState().blocks)).toHaveLength(1)
    render()
    expect(useTourStore.getState().blocks).toEqual({})
  })
})
