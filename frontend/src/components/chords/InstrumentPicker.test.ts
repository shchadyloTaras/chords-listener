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
  // jsdom has neither matchMedia nor CSS.escape (the menu restores focus with it)
  window.matchMedia = ((query: string) => ({
    matches: query === WIDE_QUERY && wide,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  if (!globalThis.CSS?.escape) (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s }
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
  expect(radios.map((r) => r.textContent)).toEqual(['Гітара', 'Бас', 'Укулеле', 'Піаніно', 'Фісгармонія', 'Хендпан'])
  click(radios[4])
  expect(useApp.getState().instrument).toBe('harmonium')
})

it('folds them into a menu on a phone', () => {
  wide = false
  render()
  expect(host.querySelector('[role="radio"]')).toBeNull()
  const trigger = host.querySelector('[aria-haspopup="menu"]')
  expect(trigger?.textContent).toContain('Гітара')
  click(trigger)
  const items = [...host.querySelectorAll('[role="menuitemradio"]')]
  expect(items.map((i) => i.textContent)).toEqual(['Гітара', 'Бас', 'Укулеле', 'Піаніно', 'Фісгармонія', 'Хендпан'])
  expect(items[0].getAttribute('aria-checked')).toBe('true')
  click(items[1])
  expect(useApp.getState().instrument).toBe('bass')
  expect(host.querySelector('[aria-haspopup="menu"]')?.textContent).toContain('Бас')
})
