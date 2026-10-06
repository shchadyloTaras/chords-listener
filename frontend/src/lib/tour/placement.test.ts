// Where the bubble goes: below or above the spotlight on a desktop, docked at the bottom on phones and for
// spotlights taller than the free area, never over the player bar or the floating video, always on screen.
import { describe, expect, it } from 'vitest'
import { freeBand, intersectRect, MARGIN, nearestDelta, placeBubble, scrollDelta, unionRect, type Rect, type View } from './placement'

const DESK: View = { width: 1280, height: 800, top: 56, bottom: 704 } // 96 px player bar
const PHONE: View = { width: 375, height: 812, top: 56, bottom: 702 } // 110 px player bar
const SIZE = { width: 352, height: 180 }
const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })
const place = (spot: Rect | null, view = DESK, phone = false, avoid: Rect[] = [], size = SIZE) => placeBubble({ spot, size, view, phone, avoid })

describe('desktop', () => {
  it('goes below the spotlight when it fits, centred on it and clamped to the viewport', () => {
    expect(place(rect(100, 100, 300, 140))).toEqual({ left: 24, top: 158, width: 352, maxHeight: 704 - 2 * MARGIN })
    expect(place(rect(1250, 100, 1270, 140)).left).toBe(1280 - 352 - MARGIN)
  })

  it('goes above when there is no room below', () => {
    expect(place(rect(500, 600, 700, 650)).top).toBe(600 - 6 - 12 - 180)
  })

  it('docks at the bottom of the free area when the spotlight is taller than it', () => {
    expect(place(rect(200, 60, 1000, 900)).top).toBe(704 - MARGIN - 180)
  })

  it('a centred card sits in the middle, above the player bar', () => {
    expect(place(null)).toEqual({ left: 464, top: 310, width: 352, maxHeight: 704 - 2 * MARGIN })
  })

  it('never overlaps the player bar: its bottom edge stays ≥ 8 px above it', () => {
    for (let top = 0; top < 800; top += 37) {
      const p = place(rect(400, top, 600, top + 40))
      expect(p.top + SIZE.height).toBeLessThanOrEqual(DESK.bottom - MARGIN)
    }
  })

  it('picks the side clear of the floating video, or moves left of it', () => {
    const video = rect(900, 450, 1264, 690)
    expect(place(rect(1000, 380, 1200, 420), DESK, false, [video]).top).toBe(380 - 6 - 12 - 180)
    const tall = place(rect(1000, 60, 1200, 900), DESK, false, [video])
    expect(tall.left + 352).toBeLessThanOrEqual(900 - MARGIN)
  })
})

describe('phones', () => {
  it('always docks at the bottom, full width with 16 px gutters, 8 px above the player bar', () => {
    for (const spot of [null, rect(16, 80, 200, 120), rect(16, 600, 200, 640)]) {
      expect(place(spot, PHONE, true)).toEqual({ left: 16, top: 702 - MARGIN - 180, width: 343, maxHeight: 702 - 2 * MARGIN })
    }
  })

  it('a long bubble on a short screen stays on screen and gets a max height', () => {
    const landscape: View = { width: 667, height: 375, top: 56, bottom: 285 }
    const p = place(null, landscape, true, [], { width: 352, height: 400 })
    expect(p.top).toBe(MARGIN)
    expect(p.maxHeight).toBe(285 - 2 * MARGIN)
    expect(p.top + Math.min(400, p.maxHeight)).toBeLessThanOrEqual(285 - MARGIN)
    // 667 px is wider than PHONE_QUERY (max-width: 639px): in the app this screen takes the desktop branch
    expect(place(null, landscape, false, [], { width: 352, height: 400 })).toEqual({ left: 157.5, top: MARGIN, width: 352, maxHeight: 285 - 2 * MARGIN })
    expect(place(rect(16, 100, 300, 140), landscape, false, [], { width: 352, height: 400 }).top).toBe(MARGIN)
  })
})

describe('scrolling', () => {
  it('leaves a spotlight that is in the free band alone, centres one that is not', () => {
    const band = { top: 64, bottom: 696 }
    expect(scrollDelta(rect(0, 200, 10, 300), band)).toBe(0)
    expect(scrollDelta(rect(0, 900, 10, 1000), band)).toBe(950 - 380)
    expect(scrollDelta(rect(0, -300, 10, -200), band)).toBe(-250 - 380)
  })

  it('brings a spotlight taller than the band to just below the header', () => {
    expect(scrollDelta(rect(0, 400, 10, 1400), { top: 64, bottom: 696 })).toBe(400 - 64)
  })

  it('the free band ends above the docked bubble on phones', () => {
    expect(freeBand(DESK, false, 180)).toEqual({ top: 64, bottom: 696 })
    expect(freeBand(PHONE, true, 180)).toEqual({ top: 64, bottom: 702 - 8 - 180 - 8 })
  })

  it('sideways: the nearest edge, the start when it does not fit', () => {
    expect(nearestDelta(10, 50, 0, 100)).toBe(0)
    expect(nearestDelta(80, 140, 0, 100)).toBe(40)
    expect(nearestDelta(-30, 10, 0, 100)).toBe(-30)
    expect(nearestDelta(20, 180, 0, 100)).toBe(20)
  })
})

describe('rects', () => {
  it('union and intersection', () => {
    expect(unionRect([])).toBeNull()
    expect(unionRect([rect(0, 0, 10, 10), rect(5, 20, 30, 25)])).toEqual(rect(0, 0, 30, 25))
    expect(intersectRect(rect(0, 0, 10, 10), rect(5, 5, 20, 20))).toEqual(rect(5, 5, 10, 10))
    expect(intersectRect(rect(0, 0, 10, 10), rect(10, 0, 20, 10))).toBeNull()
  })
})
