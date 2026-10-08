// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { harmoniumVoicing } from '../../../lib/diagrams/harmonium'
import { parseChord } from '../../../lib/music/chord'
import { HARMONIUM_ASPECT, HarmoniumChart } from './HarmoniumChart'

let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

const COLOR = 'rgb(1, 2, 3)'

function render(label: string, extra: { sounding?: ReadonlySet<number>; onKey?(key: number): void } = {}) {
  const voicing = harmoniumVoicing(parseChord(label)!)
  act(() => root!.render(createElement(HarmoniumChart, { voicing, color: COLOR, width: 132, title: `${label} — harmonium`, ...extra })))
  return host.querySelector('svg')!
}

/** The keys in the order they are drawn: 22 white (low → high), then 15 black. */
const keys = (svg: SVGSVGElement) => [...svg.querySelectorAll('[style*="cursor: pointer"]')]

it('draws the instrument at its own proportions, without any text', () => {
  const svg = render('C')
  expect(svg.getAttribute('role')).toBe('img')
  expect(svg.getAttribute('aria-label')).toBe('C — harmonium')
  expect(Number(svg.getAttribute('height'))).toBeCloseTo(132 * HARMONIUM_ASPECT, 6)
  expect(HARMONIUM_ASPECT).toBeGreaterThan(0.3)
  expect(HARMONIUM_ASPECT).toBeLessThan(0.45)
  expect(svg.querySelector('text')).toBeNull()
})

it('opens the bellows at the low end (the left hand pumps there), hinged at the high end', () => {
  const svg = render('C')
  // the bellows' back edge runs from the low (left) end to the high (right) end; both reach down to the body
  const back = svg.querySelector('path[fill="#15110f"]')!.getAttribute('d')!
  const [low, high] = /^M[\d.]+ ([\d.]+)L[\d.]+ ([\d.]+)/.exec(back)!.slice(1).map(Number)
  expect(low).toBeLessThan(high)
})

it('lights the right hand\'s chord tones, with no bass marker (the left hand pumps the bellows)', () => {
  const svg = render('Am') // A4 C5 E5
  const lit = [...svg.querySelectorAll(`[fill="${COLOR}"]`)]
  expect(lit).toHaveLength(3)
  const markers = [...svg.querySelectorAll('circle')].filter((c) => c.style.pointerEvents === 'none')
  expect(markers).toHaveLength(0)
})

it('makes all 37 keys clickable, each reporting its own index (0 = C3)', () => {
  const pressed: number[] = []
  const svg = render('C', { onKey: (k) => pressed.push(k) })
  const all = keys(svg)
  expect(all).toHaveLength(37)
  act(() => {
    all[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) // C3
    all[21].dispatchEvent(new MouseEvent('click', { bubbles: true })) // C6, the last white key
    all[22].dispatchEvent(new MouseEvent('click', { bubbles: true })) // C#3, the first black key
  })
  expect(pressed).toEqual([0, 36, 1])
})

it('presses the sounding keys under a sheen', () => {
  const svg = render('C', { sounding: new Set([0, 16]), onKey: () => {} })
  const sheens = [...svg.querySelectorAll('path[pointer-events="none"]')] as SVGPathElement[]
  expect(sheens).toHaveLength(37)
  expect(sheens.filter((s) => Number(s.style.opacity) > 0)).toHaveLength(2)
  const down = keys(svg).filter((k) => (k as SVGElement).style.transform.startsWith('translateY'))
  expect(down).toHaveLength(2)
})
