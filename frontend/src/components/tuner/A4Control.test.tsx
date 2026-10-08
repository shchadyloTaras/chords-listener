// @vitest-environment jsdom
// The A4 field: steps of 1 Hz, a typed value only on Enter / leaving the field, clamped; junk is dropped.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { A4Control } from './A4Control'

let root: Root
let host: HTMLDivElement
const onChange = vi.fn()

function render(value: number) {
  act(() => root.render(createElement(A4Control, { value, onChange })))
}
const field = () => host.querySelector('input')!
const button = (n: number) => host.querySelectorAll('button')[n]

/** types into the controlled input the way React notices */
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string) => act(() => field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
const leave = () =>
  act(() => {
    field().focus()
    field().blur()
  })

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onChange.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('A4Control', () => {
  it('− and + move A4 by 1 Hz', () => {
    render(440)
    act(() => button(0).click())
    act(() => button(1).click())
    expect(onChange.mock.calls).toEqual([[439], [441]])
  })

  it('does not apply a half-typed value, only on Enter', () => {
    render(440)
    type('4')
    type('44')
    expect(onChange).not.toHaveBeenCalled()
    type('442')
    press('Enter')
    expect(onChange).toHaveBeenCalledWith(442)
  })

  it('applies on leaving the field, clamped to 400..480, with a comma as decimal mark', () => {
    render(440)
    type('9')
    leave()
    type('1000')
    leave()
    type('441,6')
    leave()
    expect(onChange.mock.calls).toEqual([[400], [480], [442]])
  })

  it('drops junk and an empty field; Escape restores the value', () => {
    render(440)
    type('abc')
    leave()
    type('')
    leave()
    type('450')
    press('Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(field().value).toBe('440')
  })

  it('the buttons stop at the ends of the range', () => {
    render(400)
    expect(button(0).disabled).toBe(true)
    render(480)
    expect(button(1).disabled).toBe(true)
  })
})
