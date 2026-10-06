// @vitest-environment jsdom
// The «Повернутись до відтворення» pill: shown while following is suspended, but not during a tour (the tour
// suspends following itself, and nothing is playing then).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useApp } from '../../store'
import { closeTour, startTour, useTourStore } from '../tour/tourStore'
import { ChordModelContext, type ChordModel } from './model'
import { Overlays } from './Overlays'
import { useChordUi } from './uiStore'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no matchMedia (framer-motion asks for reduced motion)
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  window.location.hash = '#/demo'
  useApp.setState({ lang: 'uk', follow: true, isPlaying: false })
  useChordUi.getState().reset()
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => closeTour('route'))
  act(() => root.unmount())
  host.remove()
  window.location.hash = ''
})

const render = () => act(() => root.render(createElement(ChordModelContext, { value: {} as ChordModel }, createElement(Overlays))))
const pill = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Повернутись до відтворення') ?? null

it('shows the pill while following is suspended', () => {
  act(() => useChordUi.getState().setFollowPaused(true))
  render()
  expect(pill()).not.toBeNull()
})

it('not while a tour runs, although the tour suspends following', () => {
  act(() => {
    startTour('song')
  })
  expect(useTourStore.getState().active?.tourId).toBe('song')
  expect(useChordUi.getState().followPaused).toBe(true)
  render()
  expect(pill()).toBeNull()
})
