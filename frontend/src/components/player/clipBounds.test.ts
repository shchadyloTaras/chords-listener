import { describe, expect, it } from 'vitest'
import { clipRestart, pastClipEnd } from './clipBounds'

const clip = { start: 72, end: 102 }

describe('fragment tracks', () => {
  it('play at or after the fragment’s end starts it again', () => {
    expect(clipRestart(102, clip)).toBe(72)
    expect(clipRestart(101.9, clip)).toBe(72)
    expect(clipRestart(130, clip)).toBe(72)
    expect(clipRestart(80, clip)).toBeNull()
    expect(clipRestart(10, clip)).toBeNull() // before the fragment the video simply plays from there
    expect(clipRestart(500, null)).toBeNull()
  })

  it('playback stops at the fragment’s end unless an A–B loop is set', () => {
    expect(pastClipEnd(102, clip, null)).toBe(true)
    expect(pastClipEnd(101.5, clip, null)).toBe(false)
    expect(pastClipEnd(110, clip, { start: 80, end: 90 })).toBe(false)
    expect(pastClipEnd(110, clip, { start: 80, end: 80 })).toBe(true) // an empty loop is no loop
    expect(pastClipEnd(110, null, null)).toBe(false)
  })
})
