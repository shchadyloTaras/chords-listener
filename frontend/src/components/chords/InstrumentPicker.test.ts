// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useApp } from '../../store'
import { InstrumentPicker, WIDE_QUERY } from './InstrumentPicker'

let root: Root | null = null
let host: HTMLDivElement
let wide = true

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query === WIDE_QUERY && wide,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  useApp.setState({ instrument: 'guitar', lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

const render = () => act(() => root!.render(createElement(InstrumentPicker)))
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click())

it('shows the six instruments as buttons on a wide screen', () => {
  wide = true
  render()
  const radios = [...host.querySelectorAll('[role="radio"]')]
  expect(radios.map((r) => r.textContent)).toEqual(['Гітара', 'Бас', 'Укулеле', 'Фортепіано', 'Фісгармонія', 'Хендпан'])
  click(radios[4])
  expect(useApp.getState().instrument).toBe('harmonium')
})

it("uses the phone's own picker on a narrow screen (never clipped by the hero)", () => {
  wide = false
  render()
  expect(host.querySelector('[role="radio"]')).toBeNull()
  expect(host.querySelector('[role="menu"], [aria-haspopup="menu"]')).toBeNull()
  const select = host.querySelector('select')!
  expect(select.getAttribute('aria-label')).toBe('Інструмент')
  expect([...select.options].map((o) => o.textContent)).toEqual(['Гітара', 'Бас', 'Укулеле', 'Фортепіано', 'Фісгармонія', 'Хендпан'])
  expect(select.value).toBe('guitar')
  act(() => {
    select.value = 'bass'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(useApp.getState().instrument).toBe('bass')
  expect(host.querySelector('select')!.value).toBe('bass')
})

it('carries its tour anchor on a wide and on a narrow screen', () => {
  for (const isWide of [true, false]) {
    wide = isWide
    act(() => root!.render(createElement(InstrumentPicker, { tour: 'song.instrument' })))
    expect(host.querySelector('[data-tour="song.instrument"]'), `wide=${isWide}`).not.toBeNull()
  }
})
