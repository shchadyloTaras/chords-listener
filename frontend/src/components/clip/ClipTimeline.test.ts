// @vitest-environment jsdom
// The fragment timeline's input: ←/→ (Shift: 5 s) move the window, but a browser shortcut that reuses the arrows
// (Cmd/Alt+← is Back) is left alone; a tap on the line moves the window there, a right click does not.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipTimeline } from './ClipTimeline'

let root: Root
let host: HTMLDivElement
const onChange = vi.fn<(start: number) => void>()

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no pointer capture
  HTMLElement.prototype.setPointerCapture = vi.fn()
  onChange.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(ClipTimeline, { start: 72, duration: 213.4, now: 0, onChange, label: 'Фрагмент' })))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const slider = () => host.querySelector<HTMLElement>('[role="slider"]')!

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    slider().dispatchEvent(e)
  })
  return e
}

/** A press and release at `x` px of a 1000 px wide line (the whole video: a tap at 900 is 192 s in). */
function click(button: number, x = 900): void {
  const line = slider()
  line.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 48, width: 1000, height: 48, x: 0, y: 0, toJSON: () => ({}) })
  Object.defineProperty(line, 'clientWidth', { value: 1000, configurable: true })
  const init = { button, clientX: x, pointerId: 1, bubbles: true, cancelable: true }
  act(() => {
    line.dispatchEvent(new PointerEvent('pointerdown', init))
  })
  act(() => {
    line.dispatchEvent(new PointerEvent('pointerup', init))
  })
}

describe('ClipTimeline keys', () => {
  it('←/→ move the window by a second, with Shift by five', () => {
    expect(press('ArrowRight').defaultPrevented).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith(73)
    press('ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith(71)
    press('ArrowRight', { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(77)
    press('Home')
    expect(onChange).toHaveBeenLastCalledWith(0)
    press('End')
    expect(onChange).toHaveBeenLastCalledWith(183)
  })

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('%s + a key is a browser shortcut: ignored and not prevented', (modifier) => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(press(key, { [modifier]: true }).defaultPrevented, `${modifier} ${key}`).toBe(false)
      expect(press(key, { [modifier]: true, shiftKey: true }).defaultPrevented, `${modifier} Shift ${key}`).toBe(false)
    }
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('ClipTimeline pointer', () => {
  it('a tap with the primary button moves the window there', () => {
    click(0)
    expect(onChange).toHaveBeenCalledWith(177)
  })

  it('a right or middle click does not move the window', () => {
    click(2)
    click(1)
    expect(onChange).not.toHaveBeenCalled()
  })
})
