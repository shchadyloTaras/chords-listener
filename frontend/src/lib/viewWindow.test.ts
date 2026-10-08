import { describe, expect, it } from 'vitest'
import { sliceWaveform, viewWindow, windowPct, windowSpan } from './viewWindow'

describe('viewWindow', () => {
  it('is the whole track for an ordinary track', () => {
    expect(viewWindow({ duration: 200 })).toEqual({ start: 0, end: 200 })
    expect(viewWindow({ duration: 200 }, 201.5)).toEqual({ start: 0, end: 201.5 })
  })

  it('is the fragment for a fragment of a video, even past the end of the audio file', () => {
    const clip = { duration: 2100, clip: { start: 2070, end: 2100 }, startOffset: 2070 }
    expect(viewWindow(clip)).toEqual({ start: 2070, end: 2100 })
    // the player reports the audio's own end (offset + file length): a fragment never runs past clip.end
    expect(viewWindow(clip, 2100.04)).toEqual({ start: 2070, end: 2100 })
    expect(viewWindow(clip, 2099.5)).toEqual({ start: 2070, end: 2099.5 })
  })

  it('starts a recording linked to a video where the recording starts', () => {
    expect(viewWindow({ duration: 300, startOffset: 120 })).toEqual({ start: 120, end: 300 })
    expect(viewWindow({ duration: 300, startOffset: 0 })).toEqual({ start: 0, end: 300 })
  })

  it('falls back to the whole track when the window makes no sense', () => {
    expect(viewWindow({ duration: 100, startOffset: 150 })).toEqual({ start: 0, end: 100 })
    expect(viewWindow({ duration: 0 })).toEqual({ start: 0, end: 0 })
    expect(viewWindow({ duration: Number.NaN })).toEqual({ start: 0, end: 0 })
  })
})

describe('sliceWaveform', () => {
  it('keeps the whole waveform (the same array) for a window over the whole track', () => {
    const w = [0.1, 0.2, 0.3]
    expect(sliceWaveform(w, 3, { start: 0, end: 3 })).toBe(w)
  })

  it('keeps the peaks inside the window: a padded fragment drops its leading silence', () => {
    // 10 peaks a second over 0..100; the fragment 70..100 has the last 300
    const w = Array.from({ length: 1000 }, (_, i) => (i < 700 ? 0 : 1))
    const s = sliceWaveform(w, 100, { start: 70, end: 100 })
    expect(s).toHaveLength(300)
    expect(s.every((p) => p === 1)).toBe(true)
  })

  it('keeps at least one peak and tolerates an empty waveform', () => {
    expect(sliceWaveform([0.5, 0.6], 2, { start: 1.99, end: 2 })).toEqual([0.6])
    expect(sliceWaveform([], 10, { start: 5, end: 10 })).toEqual([])
  })
})

describe('windowPct / windowSpan', () => {
  const w = { start: 2070, end: 2100 }

  it('places times in the window', () => {
    expect(windowPct(2070, w)).toBe(0)
    expect(windowPct(2085, w)).toBe(50)
    expect(windowPct(2100, w)).toBe(100)
    expect(windowPct(0, w)).toBe(0)
    expect(windowPct(2100.04, w)).toBe(100)
    expect(windowPct(5, { start: 0, end: 0 })).toBe(0)
  })

  it('clips a range to the window and drops one outside it', () => {
    expect(windowSpan(2076, 2082, w)).toEqual({ left: 20, width: 20 })
    // the lead-in before a fragment ("N" from 0) ends where the fragment starts
    expect(windowSpan(0, 2070, w)).toBeNull()
    expect(windowSpan(0, 2073, w)).toEqual({ left: 0, width: 10 })
    expect(windowSpan(2097, 2200, w)).toEqual({ left: 90, width: 10 })
    expect(windowSpan(2100, 2110, w)).toBeNull()
  })
})
