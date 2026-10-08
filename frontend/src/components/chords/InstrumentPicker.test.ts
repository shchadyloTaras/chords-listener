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

it('shows the eight instruments as buttons on a wide screen', () => {
  wide = true
  render()
  const radios = [...host.querySelectorAll('[role="radio"]')]
  expect(radios.map((r) => r.textContent)).toEqual(['Гітара', 'Бас', 'Укулеле', 'Фортепіано', 'Фісгармонія', 'Хендпан', 'Сопілка', 'Флейта'])
  click(radios[4])
  expect(useApp.getState().instrument).toBe('harmonium')
})

it('opens its own menu on a narrow screen: the eight instruments, the current one checked', () => {
  wide = false
  render()
  expect(host.querySelector('select')).toBeNull()
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  expect(trigger.getAttribute('aria-label')).toBe('Інструмент: Гітара')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  // in a portal: the hero's overflow-hidden never clips it
  const menu = document.body.querySelector('[role="menu"]')!
  expect(host.contains(menu)).toBe(false)
  expect(menu.getAttribute('aria-label')).toBe('Інструмент')
  const items = [...menu.querySelectorAll('[role="menuitemradio"]')]
  expect(items.map((i) => i.textContent)).toEqual(['Гітара', 'Бас', 'Укулеле', 'Фортепіано', 'Фісгармонія', 'Хендпан', 'Сопілка', 'Флейта'])
  expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false'])
  click(items[1])
  expect(useApp.getState().instrument).toBe('bass')
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
  expect(trigger.getAttribute('aria-label')).toBe('Інструмент: Бас')
})

it('moves through the menu with the arrow keys', () => {
  wide = false
  render()
  click(host.querySelector('button[aria-haspopup="menu"]'))
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  items[0].focus()
  const key = (k: string) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
  key('ArrowDown')
  expect(document.activeElement).toBe(items[1])
  key('ArrowUp')
  key('ArrowUp')
  expect(document.activeElement).toBe(items[7])
  key('Home')
  expect(document.activeElement).toBe(items[0])
  key('End')
  expect(document.activeElement).toBe(items[7])
})

it('carries its tour anchor on a wide and on a narrow screen', () => {
  for (const isWide of [true, false]) {
    wide = isWide
    act(() => root!.render(createElement(InstrumentPicker, { tour: 'song.instrument' })))
    expect(host.querySelector('[data-tour="song.instrument"]'), `wide=${isWide}`).not.toBeNull()
  }
})

it('looks like a control on a narrow screen: a visible «Інструмент» label and the instrument’s icon', () => {
  wide = false
  render()
  expect(host.textContent).toContain('Інструмент')
  expect(host.querySelector('svg.lucide-guitar')).not.toBeNull()
  act(() => useApp.setState({ instrument: 'harmonium' }))
  expect(host.querySelector('svg.lucide-harmonium')).not.toBeNull()
  act(() => useApp.setState({ instrument: 'handpan' }))
  expect(host.querySelector('svg.lucide-handpan')).not.toBeNull()
  act(() => useApp.setState({ instrument: 'sopilka' }))
  expect(host.querySelector('svg.lucide-sopilka')).not.toBeNull()
  act(() => useApp.setState({ instrument: 'flute' }))
  expect(host.querySelector('svg.lucide-flute')).not.toBeNull()
})

it('gives every instrument an icon of its own in the menu', () => {
  wide = false
  render()
  click(host.querySelector('button[aria-haspopup="menu"]'))
  const icons = [...document.body.querySelectorAll('[role="menuitemradio"] > span[aria-hidden] > svg')].map((svg) =>
    [...svg.classList].find((c) => c.startsWith('lucide-')),
  )
  expect(icons).toEqual(['lucide-guitar', 'lucide-bass-guitar', 'lucide-ukulele', 'lucide-piano', 'lucide-harmonium', 'lucide-handpan', 'lucide-sopilka', 'lucide-flute'])
})
