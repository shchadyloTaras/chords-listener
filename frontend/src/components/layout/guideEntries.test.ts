// @vitest-environment jsdom
// «Інструкція» in three places — the ⋯ menu (phones: every route; desktop: track pages), the desktop header
// button, the shortcuts dialog — each shown only when the app passes onGuide (a screen with a tour).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnection } from '../../lib/serverMode'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { GuideButton } from './HeaderSettings'
import { ServerStatus } from './ServerStatus'
import { ShortcutsModal } from './ShortcutsModal'
import { HeaderMenu } from './TrackActions'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no CSS.escape (Menu focuses its trigger with it when an item is chosen)
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (node: Parameters<Root['render']>[0]) => act(() => root.render(node))
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes(text)) ?? null
const click = (el: HTMLElement | null) => act(() => el!.click())
const TRACK = { id: 't1', title: 'Song', source: { type: 'file' } } as unknown as Track

describe('the shortcuts dialog', () => {
  it('ends with an «Інструкція» line that runs the guide', () => {
    const onGuide = vi.fn()
    render(createElement(ShortcutsModal, { open: true, onClose: () => {}, onGuide }))
    expect(document.body.textContent).toContain('Що робить кожна кнопка, покаже інструкція.')
    click(byText('Інструкція'))
    expect(onGuide).toHaveBeenCalledTimes(1)
  })

  it('has no such line where there is no tour', () => {
    render(createElement(ShortcutsModal, { open: true, onClose: () => {} }))
    expect(byText('Інструкція')).toBeNull()
  })
})

describe('the ⋯ menu', () => {
  it('phones: «Інструкція» after the shortcuts, on any route', () => {
    const onGuide = vi.fn()
    render(createElement(HeaderMenu, { track: null, demo: false, withSettings: true, onHelp: () => {}, onGuide }))
    click(document.querySelector<HTMLElement>('[aria-label="Більше дій"]'))
    const items = [...document.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent)
    expect(items.at(-1)).toContain('Інструкція')
    click(byText('Інструкція'))
    expect(onGuide).toHaveBeenCalledTimes(1)
  })

  it('desktop track menu: «Інструкція» after the track actions', () => {
    render(createElement(HeaderMenu, { track: TRACK, demo: false, withSettings: false, onHelp: () => {}, onGuide: () => {} }))
    click(document.querySelector<HTMLElement>('[aria-label="Більше дій"]'))
    const items = [...document.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent)
    expect(items.at(-1)).toContain('Інструкція')
  })

  it('no item without a tour', () => {
    render(createElement(HeaderMenu, { track: null, demo: false, withSettings: true, onHelp: () => {} }))
    click(document.querySelector<HTMLElement>('[aria-label="Більше дій"]'))
    expect(byText('Інструкція')).toBeNull()
  })
})

it('the desktop header button is an icon button labelled «Інструкція»', () => {
  const onGuide = vi.fn()
  render(createElement(GuideButton, { onGuide }))
  const button = document.querySelector<HTMLElement>('[aria-label="Інструкція"]')
  expect(button).not.toBeNull()
  click(button)
  expect(onGuide).toHaveBeenCalledTimes(1)
})

it('leaves the button room in a 640 px header: the mode chip on Home / Listen / YouTube shows its words only from 768 px', () => {
  // at 640–655 px the chip's «Браузерний режим» plus the new button pushed «Увійти» past the edge of the page
  useConnection.setState({ status: 'browser' })
  render(createElement(ServerStatus))
  const chip = document.querySelector<HTMLElement>('[data-tour="header.mode"]')!
  const words = [...chip.querySelectorAll('span')].find((s) => s.textContent === 'Браузерний режим')!
  expect(words.className).toContain('md:inline')
  expect(words.className).not.toContain('sm:inline')
  expect(chip.className).toContain('md:w-auto')
  expect(chip.className).not.toContain('sm:w-auto')
})
