import { describe, expect, it } from 'vitest'
import { CLIP_SECONDS, clampStart, clipWindow, maxStart, nudgeStart, startAt, startFromDrag, startFromTap } from './clipWindow'

describe('the fragment window', () => {
  it('is 30 s, the server’s CHORDS_YT_CLIP_S', () => expect(CLIP_SECONDS).toBe(30))

  it('never runs past the end of the video', () => {
    expect(maxStart(213.4)).toBe(183)
    expect(clampStart(200, 213.4)).toBe(183)
    expect(clipWindow(200, 213.4)).toEqual({ start: 183, end: 213 })
    expect(clampStart(99999, 213.4)).toBe(183) // ?t= past the end
  })

  it('takes a video shorter than the window whole', () => {
    expect(maxStart(20)).toBe(0)
    expect(clipWindow(10, 20)).toEqual({ start: 0, end: 20 })
  })

  it('trusts the start while the length is unknown', () => {
    expect(maxStart(null)).toBe(Number.POSITIVE_INFINITY)
    expect(clipWindow(72, null)).toEqual({ start: 72, end: 102 })
    expect(clampStart(72.9, null)).toBe(72)
    expect(clampStart(-5, null)).toBe(0)
    expect(clampStart(Number.NaN, 100)).toBe(0)
    expect(clampStart(99999, null)).toBe(86400)
    expect(clipWindow(99999, null)).toEqual({ start: 86400, end: 86430 })
  })

  it('moves by the keyboard and from the playhead', () => {
    expect(nudgeStart(72, 1, 213.4)).toBe(73)
    expect(nudgeStart(72, -5, 213.4)).toBe(67)
    expect(nudgeStart(2, -5, 213.4)).toBe(0)
    expect(nudgeStart(183, 5, 213.4)).toBe(183)
    expect(startAt(84.7, 213.4)).toBe(84)
    expect(startAt(205, 213.4)).toBe(183)
  })

  it('a tap centres the window there; a drag follows the pointer', () => {
    expect(startFromTap(0.5, 200)).toBe(85)
    expect(startFromTap(0, 200)).toBe(0)
    expect(startFromTap(1, 200)).toBe(170)
    expect(startFromDrag(72, 100, 400, 200)).toBe(122) // a quarter of the line = 50 s
    expect(startFromDrag(72, -400, 400, 200)).toBe(0)
    expect(startFromDrag(72, 10, 0, 200)).toBe(72) // not laid out yet
  })
})
