// Every anchor the tours name is set on a real element in src/components, and every literal data-tour in the
// components is one the tours use (the tour finds its spotlight by these ids; a renamed or deleted attribute
// would silently drop a step, a stray one is a typo).
import { describe, expect, it } from 'vitest'
import { tourAnchors, TOUR_IDS, TOURS } from '../../lib/tour/tours'

const sources = import.meta.glob<string>('/src/components/**/*.tsx', { query: '?raw', import: 'default', eager: true })

// `data-tour="id"` or `data-tour={cond ? 'id' : …}` (the first id of an expression): a bare quoted string would
// also match the same id used as a t() key
const ANCHOR_ATTR = /\b(?:data-)?tour=(?:"([^"]+)"|\{[^}]*?'([^']+)')/g
const anchorsInCode = new Set<string>()
for (const source of Object.values(sources))
  for (const m of source.matchAll(ANCHOR_ATTR)) anchorsInCode.add(m[1] ?? m[2])

describe('tour anchors in the code', () => {
  it.each(TOUR_IDS)('%s: every anchor is set in a component', (id) => {
    for (const step of TOURS[id].steps)
      for (const anchor of step.anchors) expect(anchorsInCode.has(anchor), anchor).toBe(true)
  })

  it('every data-tour / tour prop in the components names a known anchor', () => {
    const known = new Set(tourAnchors())
    expect(anchorsInCode.size).toBeGreaterThan(30)
    expect([...anchorsInCode].filter((id) => !known.has(id))).toEqual([])
  })
})
