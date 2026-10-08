// @vitest-environment jsdom
// The tour on screen: a modal dialog with the step's title, text and counter; → ← Enter Space Esc (also with a
// Floating panel open), Tab kept inside the bubble, focus start and restore, the layer swallowing presses,
// key auto-repeat and modified combos ignored, Space keyup cancelled, the chord-marks card and key chips, an anchor
// gone only after 300 ms, smooth vs reduced motion (the bubble never slides in), room below a short page on phones,
// and a route change closing it unseen.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTourSeen } from '../../lib/tour/storage'
import { useApp } from '../../store'
import { Floating } from '../chords/ui/Floating'
import { TourHost } from './TourHost'
import { startTour, useTourStore } from './tourStore'

const RECT = { x: 100, y: 100, left: 100, top: 100, right: 220, bottom: 140, width: 120, height: 40, toJSON: () => ({}) } as DOMRect
const made: HTMLElement[] = []
function anchor(id: string): HTMLElement {
  const el = document.createElement('button')
  el.dataset.tour = id
  el.textContent = id
  el.getClientRects = () => [RECT] as unknown as DOMRectList
  el.getBoundingClientRect = () => RECT
  document.body.append(el)
  made.push(el)
  return el
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  window.location.hash = '#/'
  // a desktop: a fine pointer, wider than 640 px
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy
  useApp.setState({ lang: 'uk', isPlaying: false, controller: null })
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  for (const id of ['home.input', 'home.sources', 'header.mode']) anchor(id)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TourHost)))
})

afterEach(() => {
  act(() => useTourStore.setState({ active: null, queue: [] }))
  act(() => root.unmount())
  // a Space that was pressed and never released leaves a one-shot keyup guard behind: spend it
  window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
  host.remove()
  made.splice(0).forEach((el) => el.remove())
})

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
const title = () => dialog()?.querySelector('h2')?.textContent ?? null
const buttons = () => [...(dialog()?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
const counterText = () => [...(dialog()?.querySelectorAll('span') ?? [])].map((s) => s.textContent).find((s) => /^\d+ \/ \d+$/.test(s ?? ''))
const keyEvent = (type: 'keydown' | 'keyup', key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(e)
  })
  return e
}
const press = (key: string, init: KeyboardEventInit = {}) => keyEvent('keydown', key, init)
const release = (key: string, init: KeyboardEventInit = {}) => keyEvent('keyup', key, init)
const begin = (id: Parameters<typeof startTour>[0] = 'home') =>
  act(() => {
    startTour(id)
  })
const go = (hash: string) =>
  act(() => {
    window.location.hash = hash
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })

describe('the bubble', () => {
  it('is a modal dialog with the title, the text in a live region and the counter; focus starts on «Далі»', () => {
    begin()
    expect(dialog()).not.toBeNull()
    expect(title()).toBe('Привіт! Це Chords Listener')
    expect(dialog()!.querySelector('[aria-live="polite"] p')?.textContent).toContain('акорди до будь-якої пісні')
    expect(counterText()).toBe('1 / 4') // welcome, link field, sources, mode chip (the rest are left out here)
    expect(buttons()).toEqual(['Пропустити', 'Далі'])
    expect(document.activeElement?.textContent).toBe('Далі')
  })

  it('→ ← Enter and Space move between steps; «Готово» on the last one closes and marks it seen', () => {
    begin()
    press('ArrowRight')
    expect(title()).toBe('Посилання або файл')
    expect(counterText()).toBe('2 / 4')
    expect(buttons()).toEqual(['Пропустити', 'Назад', 'Далі'])
    press('ArrowLeft')
    expect(title()).toBe('Привіт! Це Chords Listener')
    press('Enter')
    expect(title()).toBe('Посилання або файл')
    press(' ')
    expect(title()).toBe('Файл, «Слухати» чи тюнер')
    press('ArrowRight')
    expect(buttons().at(-1)).toBe('Готово')
    press('Enter')
    expect(dialog()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('«Пропустити» closes it and marks it seen', () => {
    begin()
    act(() => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Пропустити')!.click())
    expect(dialog()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('Esc closes it even with a Floating panel open, and the panel does not see the key', () => {
    const onClose = vi.fn()
    const panelHost = document.createElement('div')
    document.body.append(panelHost)
    const panelRoot = createRoot(panelHost)
    // FloatingProps.children is required, so createElement needs it in the props
    // oxlint-disable-next-line react/no-children-prop
    act(() => panelRoot.render(createElement(Floating, { anchor: made[0], open: true, onClose, children: 'panel' })))
    begin()
    press('Escape')
    expect(dialog()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    act(() => panelRoot.unmount())
    panelHost.remove()
  })

  it('keeps Tab inside the bubble', () => {
    begin()
    press('ArrowRight')
    expect(document.activeElement?.textContent).toBe('Далі')
    press('Tab')
    expect(document.activeElement?.textContent).toBe('Пропустити')
    press('Tab', { shiftKey: true })
    expect(document.activeElement?.textContent).toBe('Далі')
  })

  it('returns focus to where it was when the tour closes', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    made.push(outside)
    outside.focus()
    begin()
    expect(document.activeElement).not.toBe(outside)
    press('Escape')
    expect(document.activeElement).toBe(outside)
  })

  it('the layer swallows presses on the page around the bubble', () => {
    begin()
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    act(() => {
      dialog()!.dispatchEvent(down)
    })
    expect(down.defaultPrevented).toBe(true)
    expect(dialog()!.className).toContain('fixed inset-0 z-[75]')
  })

  it('a held key does not race through the tour', () => {
    begin()
    for (let i = 0; i < 5; i++) press('ArrowRight', { repeat: true })
    press('Enter', { repeat: true })
    expect(counterText()).toBe('1 / 4')
  })

  it('leaves browser shortcuts alone: Alt+← (Back), Cmd+←, Alt+→, Ctrl+Enter and Cmd+Space do nothing and are not cancelled', () => {
    begin()
    press('ArrowRight')
    expect(title()).toBe('Посилання або файл')
    const combos: [string, KeyboardEventInit][] = [
      ['ArrowLeft', { altKey: true }],
      ['ArrowLeft', { metaKey: true }],
      ['ArrowRight', { altKey: true }],
      ['Enter', { ctrlKey: true }],
      [' ', { metaKey: true }],
      ['Escape', { ctrlKey: true }],
    ]
    for (const [key, init] of combos) {
      const e = press(key, init)
      expect(e.defaultPrevented, `${key} ${JSON.stringify(init)}`).toBe(false)
      expect(title(), `${key} ${JSON.stringify(init)}`).toBe('Посилання або файл')
    }
    expect(dialog()).not.toBeNull()
    // Shift alone still counts: Shift+Tab walks backwards in the bubble
    press('Tab', { shiftKey: true })
    expect(document.activeElement?.textContent).toBe('Назад')
  })

  it('cancels the Space keyup too, so Firefox does not click the focused button a second time', () => {
    begin()
    press(' ')
    expect(title()).toBe('Посилання або файл')
    expect(release(' ').defaultPrevented).toBe(true)
    expect(release('ArrowRight').defaultPrevented).toBe(false)
  })

  it('...and when the Space press closes the tour on «Готово», its keyup does not click the restored element', () => {
    begin()
    press('ArrowRight')
    press('ArrowRight')
    press('ArrowRight')
    expect(buttons().at(-1)).toBe('Готово')
    press(' ')
    expect(dialog()).toBeNull()
    expect(release(' ').defaultPrevented).toBe(true)
    // only that one release: later Space presses on the page are the page's
    expect(release(' ').defaultPrevented).toBe(false)
  })

  it('a keyup of Space after the tour closed some other way is left alone', () => {
    begin()
    press('Escape')
    expect(release(' ').defaultPrevented).toBe(false)
  })
})

describe('content', () => {
  it('Song step 7 is a centred card with the chord marks (an unsure example underlined)', () => {
    go('#/demo')
    begin('song')
    expect(title()).toBe('Що означають позначки')
    expect(dialog()!.querySelector('.cw-lowconf')).not.toBeNull()
    expect(dialog()!.textContent).toContain('після риски — нота в басі')
    expect(buttons().at(-1)).toBe('Готово')
  })

  it('shows key chips with a fine pointer and none on touch', () => {
    go('#/demo')
    anchor('song.instrument')
    begin('song')
    expect(dialog()!.querySelector('kbd')?.textContent).toBe('I')
    act(() => useTourStore.setState((s) => ({ flags: { ...s.flags, touch: true } })))
    expect(dialog()!.querySelector('kbd')).toBeNull()
  })
})

describe('anchors and motion', () => {
  it('an anchor counts as gone only if it is still missing 300 ms after it vanished', async () => {
    // the MutationObserver callback is a microtask: the async advance runs it before the timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      begin()
      press('ArrowRight')
      const input = made.find((el) => el.dataset.tour === 'home.input')!
      // a re-render that swaps the anchor out and back: the step stays
      input.remove()
      await act(() => vi.advanceTimersByTimeAsync(200))
      document.body.append(input)
      await act(() => vi.advanceTimersByTimeAsync(400))
      expect(title()).toBe('Посилання або файл')
      // gone for good: the tour moves on to the next step
      input.remove()
      await act(() => vi.advanceTimersByTimeAsync(350))
      expect(title()).toBe('Файл, «Слухати» чи тюнер')
    } finally {
      vi.useRealTimers()
    }
  })

  it('scrolls a step into view smoothly and animates the cut-out and the bubble', () => {
    made[0].getBoundingClientRect = () => ({ ...RECT, top: 2000, bottom: 2040, y: 2000 })
    begin()
    press('ArrowRight')
    expect(window.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    expect(dialog()!.querySelector('h2')!.closest('div.absolute')!.className).toContain('transition-[')
  })

  it('the bubble is placed without a transition: it never slides in from where it was parked', () => {
    // React sets style.left on the bubble when the first geometry arrives; a transition class that is already on
    // the element at that moment (or arrives with it) would animate it from the parked -9999 to its place
    let owner: object | null = document.body.style
    while (owner && !Object.getOwnPropertyDescriptor(owner, 'left')) owner = Object.getPrototypeOf(owner)
    const left = Object.getOwnPropertyDescriptor(owner!, 'left')!
    const classAtLeft: { left: string; className: string }[] = []
    Object.defineProperty(owner!, 'left', {
      ...left,
      set(this: CSSStyleDeclaration, v: string) {
        left.set!.call(this, v)
        classAtLeft.push({ left: String(v), className: document.querySelector('[role="dialog"] h2')?.closest('div.absolute')?.className ?? '' })
      },
    })
    try {
      begin()
      press('ArrowRight')
    } finally {
      Object.defineProperty(owner!, 'left', left)
    }
    const placing = classAtLeft.filter((c) => c.className && !c.left.startsWith('-9999'))
    expect(placing.length).toBeGreaterThan(0)
    expect(placing[0].className).not.toContain('transition-[')
    // after that it animates between steps as before
    expect(dialog()!.querySelector('h2')!.closest('div.absolute')!.className).toContain('transition-[')
  })

  it('phones: an anchor near the end of a short page gets room below the page to clear the docked bubble; it goes with the tour', () => {
    act(() => root.unmount())
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    root = createRoot(host)
    act(() => root.render(createElement(TourHost)))
    // the page is 900 px long in a 768 px window: it scrolls 132 px at most
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 900 })
    try {
      made[0].getBoundingClientRect = () => ({ ...RECT, top: 1000, bottom: 1040, y: 1000 })
      begin()
      press('ArrowRight')
      const room = document.querySelector<HTMLElement>('[data-tour-room]')
      expect(window.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ top: 640 }))
      expect(room?.style.top).toBe('900px')
      expect(room?.style.height).toBe(`${640 - 132}px`)
      expect(room?.getAttribute('aria-hidden')).toBe('true')
      press('Escape')
      expect(document.querySelector('[data-tour-room]')).toBeNull()
    } finally {
      delete (document.documentElement as { scrollHeight?: number }).scrollHeight
    }
  })

  it('a short window wider than a phone (a phone in landscape) docks the bubble and gets the room too, but keeps the desktop steps', () => {
    act(() => root.unmount())
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-height: 499px)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    root = createRoot(host)
    act(() => root.render(createElement(TourHost)))
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 900 })
    try {
      made[0].getBoundingClientRect = () => ({ ...RECT, top: 1000, bottom: 1040, y: 1000 })
      begin()
      press('ArrowRight')
      // the content stays the desktop one (header.settings, not ⋯)
      expect(useTourStore.getState().flags.phone).toBe(false)
      expect(window.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ top: 640 }))
      expect(document.querySelector('[data-tour-room]')).not.toBeNull()
      // docked at the bottom, centred, 640 px wide (jsdom: a 1024 × 768 window, no header or player bar)
      const bubble = dialog()!.querySelector('h2')!.closest<HTMLElement>('div.absolute')!
      expect([bubble.style.left, bubble.style.top, bubble.style.width]).toEqual(['192px', `${768 - 8 - 180}px`, '640px'])
    } finally {
      delete (document.documentElement as { scrollHeight?: number }).scrollHeight
    }
  })

  it('a desktop page gets no such room', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 900 })
    try {
      made[0].getBoundingClientRect = () => ({ ...RECT, top: 1000, bottom: 1040, y: 1000 })
      begin()
      press('ArrowRight')
      expect(window.scrollBy).toHaveBeenCalled()
      expect(document.querySelector('[data-tour-room]')).toBeNull()
    } finally {
      delete (document.documentElement as { scrollHeight?: number }).scrollHeight
    }
  })

  it('with prefers-reduced-motion: no smooth scrolling, no transitions', () => {
    act(() => root.unmount())
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)' || query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    root = createRoot(host)
    act(() => root.render(createElement(TourHost)))
    made[0].getBoundingClientRect = () => ({ ...RECT, top: 2000, bottom: 2040, y: 2000 })
    begin()
    press('ArrowRight')
    expect(window.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }))
    expect(dialog()!.querySelector('h2')!.closest('div.absolute')!.className).not.toContain('transition-[')
  })
})

it('leaving the screen closes the tour at once without marking it seen', () => {
  begin()
  go('#/listen')
  expect(dialog()).toBeNull()
  expect(isTourSeen('home')).toBe(false)
})
