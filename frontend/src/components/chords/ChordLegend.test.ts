// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { UniqueChord } from '../../lib/music/display'
import { useApp } from '../../store'
import { ChordLegend } from './ChordLegend'
import { ChordModelContext, type ChordModel } from './model'

let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'uk', showDiagrams: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

const AM: UniqueChord = { label: 'Am', rootPc: 9, quality: 'min', count: 3, seconds: 6, firstIndex: 0 }

function render() {
  const model = { unique: [AM], spelling: 'sharp', sections: [], chords: [], track: { id: 't' } } as unknown as ChordModel
  act(() => root!.render(createElement(ChordModelContext, { value: model }, createElement(ChordLegend))))
}

// a 360 px phone (the narrowest common one) minus the workspace's 16 px gutters; tiles are gap-2
// apart and add px-2 padding + a 1 px border around the diagram
const LIST = 360 - 2 * 16
const GAP = 8
const TILE_CHROME = 2 * 8 + 2 * 1

it.each(['piano', 'harmonium'] as const)('%s: the small diagram fits a tile, two tiles per row on a 360 px phone', (instrument) => {
  useApp.setState({ instrument })
  render()
  const min = Number(/minmax\((\d+)px/.exec(host.querySelector('ul')!.className)![1])
  const keyboard = [...host.querySelector('figure')!.querySelectorAll('svg')].at(-1)!
  expect(Number(keyboard.getAttribute('width')) + TILE_CHROME).toBeLessThanOrEqual(min)
  expect(2 * min + GAP).toBeLessThanOrEqual(LIST)
})
