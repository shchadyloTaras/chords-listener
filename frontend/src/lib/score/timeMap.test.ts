import { describe, expect, it } from 'vitest'
import { effectiveRhythm } from '../tempo/rhythm'
import { buildBarGrid } from '../music/bars'
import { steadyBars } from './__fixtures__/song'
import { barStretch, buildTimeMap, DIV, quantize } from './timeMap'

describe('buildTimeMap', () => {
  it('maps seconds to ticks through the beats (one beat = DIV ticks)', () => {
    const { bars } = steadyBars({ bpm: 120, bars: 4 })
    const map = buildTimeMap(bars, 4)
    expect(map.measures).toHaveLength(4)
    expect(map.measures.map((m) => m.number)).toEqual(['1', '2', '3', '4'])
    expect(map.measures[1].offset).toBe(16)
    expect(map.totalTicks).toBe(64)
    expect(map.toTicks(0)).toBeCloseTo(0)
    expect(map.toTicks(0.5)).toBeCloseTo(DIV)
    expect(map.toTicks(2.25)).toBeCloseTo(18)
    expect(map.toSeconds(18)).toBeCloseTo(2.25)
  })

  it('is piecewise linear between uneven beats', () => {
    // beats 0.5 s, then a slow beat of 0.6 s, then 0.4 s
    const beats = [0, 0.5, 1.1, 1.5, 2, 2.5, 3, 3.5]
    const frames = buildBarGrid({ duration: 4, beats, downbeats: [0, 2], tempo: 120, timeSignature: 4 })
    const map = buildTimeMap(frames, 4)
    expect(map.toTicks(0.8)).toBeCloseTo(4 + 2) // halfway through the slow beat
    expect(map.toTicks(1.3)).toBeCloseTo(8 + 2)
    for (const t of [0.1, 0.77, 1.42, 2.2, 3.9]) expect(map.toSeconds(map.toTicks(t))).toBeCloseTo(t, 6)
  })

  it('honours the tempo correction: ×2 doubles the ticks per second', () => {
    const { beats } = steadyBars({ bpm: 60, bars: 4 })
    const doubled = effectiveRhythm({ beats, downbeats: beats.filter((_, i) => i % 4 === 0), tempo: 60, timeSignature: 4, duration: 16 }, 2)
    const frames = buildBarGrid({ duration: 16, beats: doubled.beats, downbeats: doubled.downbeats, tempo: doubled.tempo, timeSignature: 4 })
    const map = buildTimeMap(frames, 4)
    // a beat is now half a second
    expect(map.toTicks(0.5)).toBeCloseTo(DIV)
    expect(map.measures[1].start).toBeCloseTo(2)
  })

  it('writes a short first bar as a pickup numbered 0', () => {
    // first downbeat at 1 s with 0.5 s beats: a two-beat pickup
    const { bars } = steadyBars({ bpm: 120, bars: 3, offset: 1 })
    const map = buildTimeMap(bars, 4)
    expect(map.measures[0]).toMatchObject({ pickup: true, number: '0', beats: 2, offset: 0 })
    expect(map.measures[1]).toMatchObject({ pickup: false, number: '1', beats: 4, offset: 8 })
    expect(map.toTicks(1)).toBeCloseTo(8)
  })

  it('pads a short last bar to a full bar', () => {
    const frames = buildBarGrid({ duration: 5.4, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], downbeats: [0, 2, 4], tempo: 120, timeSignature: 4 })
    const map = buildTimeMap(frames, 4)
    const last = map.measures[map.measures.length - 1]
    expect(last.beats).toBe(4)
    expect(last.ticks).toBe(16)
  })

  it('splits a long last bar into a full bar and a padded one', () => {
    // 4/4 at 120: the last bar absorbed a 5th beat (the song ends one beat into a new bar)
    const frames = [
      { start: 0, end: 2, boundaries: [0, 0.5, 1, 1.5, 2], pickup: false },
      { start: 2, end: 4.5, boundaries: [2, 2.5, 3, 3.5, 4, 4.5], pickup: false },
    ]
    const map = buildTimeMap(frames, 4)
    expect(map.measures.map((m) => [m.number, m.beats])).toEqual([
      ['1', 4],
      ['2', 4],
      ['3', 4],
    ])
    expect(map.measures[2].start).toBeCloseTo(4)
    expect(map.toTicks(4.25)).toBeCloseTo(32 + 2)
    // the sheet's last bar goes on over the extra measure
    expect(barStretch(map.measures, 0, 2)).toEqual({ offset: 0, beats: 4, barlines: [] })
    expect(barStretch(map.measures, 1, 2)).toEqual({ offset: 16, beats: 8, barlines: [4] })
    expect(barStretch(map.measures, 3, 4)).toBeNull()
  })

  it('extrapolates before the first and after the last beat', () => {
    const { bars } = steadyBars({ bpm: 120, bars: 2 })
    const map = buildTimeMap(bars, 4)
    expect(map.toTicks(-0.5)).toBeCloseTo(-DIV)
    expect(map.toTicks(4.5)).toBeCloseTo(36)
    expect(map.toSeconds(36)).toBeCloseTo(4.5)
    expect(map.measureAtTick(-3)).toBe(0)
    expect(map.measureAtTick(999)).toBe(1)
  })

  it('quantizes to sixteenths or eighths', () => {
    const { bars } = steadyBars({ bpm: 120, bars: 2 })
    const map = buildTimeMap(bars, 4)
    // 0.19 s = 1.52 sixteenths
    expect(quantize(map, 0.19, 1)).toBe(2)
    expect(quantize(map, 0.19, 2)).toBe(2)
    expect(quantize(map, 0.12, 2)).toBe(0)
    expect(quantize(map, 0.13, 1)).toBe(1)
  })
})
