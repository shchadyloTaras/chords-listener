// Every anchor a wired tour names is set on a real element in src/components: the tour finds its spotlight by
// these ids, so a renamed or deleted attribute would silently drop a step.
import { describe, expect, it } from 'vitest'
import { TOURS, type TourId } from '../../lib/tour/tours'

const sources = import.meta.glob<string>('/src/components/**/*.tsx', { query: '?raw', import: 'default', eager: true })

// `data-tour="id"` or `data-tour={cond ? 'id' : …}` (the first id of an expression): a bare quoted string would
// also match the same id used as a t() key
const ANCHOR_ATTR = /\b(?:data-)?tour=(?:"([^"]+)"|\{[^}]*?'([^']+)')/g
const anchorsInCode = new Set<string>()
for (const source of Object.values(sources))
  for (const m of source.matchAll(ANCHOR_ATTR)) anchorsInCode.add(m[1] ?? m[2])

/** tours whose screens are wired so far (each wiring task adds its own) */
const WIRED: TourId[] = ['home', 'song']

describe('tour anchors in the code', () => {
  it.each(WIRED)('%s: every anchor is set in a component', (id) => {
    for (const step of TOURS[id].steps)
      for (const anchor of step.anchors) expect(anchorsInCode.has(anchor), anchor).toBe(true)
  })
})
