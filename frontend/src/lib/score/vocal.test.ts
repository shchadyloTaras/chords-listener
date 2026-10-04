import { describe, expect, it } from 'vitest'
import { steadyBars } from './__fixtures__/song'
import { buildTimeMap, DIV } from './timeMap'
import { medianPitch, quantizeVocal, type NoteRow } from './vocal'

// 120 BPM: a beat = 0.5 s, a sixteenth = 0.125 s
const map = buildTimeMap(steadyBars({ bpm: 120, bars: 4 }).bars, 4)
const sixteenth = 0.125

describe('quantizeVocal', () => {
  it('snaps onsets and offsets to the grid', () => {
    const rows: NoteRow[] = [
      [0.02, 0.48, 67, 0.8],
      [0.51, 0.74, 69, 0.8],
      [0.76, 1.49, 71, 0.8],
    ]
    expect(quantizeVocal(rows, map, { step: 1 })).toEqual([
      { start: 0, end: 4, pitches: [67], velocity: 0.8 },
      { start: 4, end: 6, pitches: [69], velocity: 0.8 },
      { start: 6, end: 12, pitches: [71], velocity: 0.8 },
    ])
  })

  it('resolves overlaps: a note ends where the next one starts', () => {
    const out = quantizeVocal(
      [
        [0, 0.7, 64, 0.8],
        [0.5, 1, 65, 0.8],
      ],
      map,
      { step: 1 },
    )
    expect(out.map((n) => [n.start, n.end])).toEqual([
      [0, 4],
      [4, 8],
    ])
  })

  it('closes gaps shorter than an eighth, keeps rests of an eighth or more', () => {
    const out = quantizeVocal(
      [
        [0, 0.36, 60, 0.8], // ends at 2.88 sixteenths → 3, next at 4: a 16th gap → closed
        [0.5, 0.74, 62, 0.8], // ends at 6, next at 8: an eighth rest → kept
        [1, 1.5, 64, 0.8],
      ],
      map,
      { step: 1 },
    )
    expect(out.map((n) => [n.start, n.end])).toEqual([
      [0, 4],
      [4, 6],
      [8, 12],
    ])
  })

  it('keeps written durations close to the sung ones', () => {
    // pseudo-random melody: durations 0.1–0.9 s, gaps 0–0.4 s
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const rows: NoteRow[] = []
    let t = 0.05
    while (t < 7.5) {
      const d = 0.1 + rnd() * 0.8
      rows.push([t, t + d, 60 + Math.floor(rnd() * 12), 0.8])
      t += d + rnd() * 0.4
    }
    const out = quantizeVocal(rows, map, { step: 1 })
    expect(out.length).toBeGreaterThan(rows.length * 0.8)
    for (const n of out) {
      // the sung note this one came from: the nearest onset
      const src = rows.reduce((best, r) => (Math.abs(map.toTicks(r[0]) - n.start) < Math.abs(map.toTicks(best[0]) - n.start) ? r : best))
      const startErr = Math.abs(map.toSeconds(n.start) - src[0])
      const endErr = map.toSeconds(n.end) - src[1]
      expect(startErr).toBeLessThanOrEqual(sixteenth / 2 + 1e-6 + sixteenth) // half a step (+ a shifted collision)
      // never more than half a step short; at most half a step + an eighth (a closed gap) long
      expect(endErr).toBeGreaterThanOrEqual(-(sixteenth / 2) - sixteenth - 1e-6)
      expect(endErr).toBeLessThanOrEqual(sixteenth / 2 + 2 * sixteenth + 1e-6)
    }
    // monophonic, sorted, non-empty
    out.forEach((n, i) => {
      expect(n.end).toBeGreaterThan(n.start)
      if (i) expect(n.start).toBeGreaterThanOrEqual(out[i - 1].end)
    })
  })

  it('moves a colliding onset to the next step, or keeps the longer note', () => {
    const shifted = quantizeVocal(
      [
        [0, 0.05 + 0.01, 60, 0.8],
        [0.04, 0.5, 62, 0.8],
      ],
      map,
      { step: 1, minDuration: 0.04, ornament: 0 },
    )
    expect(shifted.map((n) => [n.start, n.end, n.pitches[0]])).toEqual([
      [0, 1, 60],
      [1, 4, 62],
    ])
    const dropped = quantizeVocal(
      [
        [0, 0.4, 60, 0.8],
        [0.05, 0.1, 62, 0.8],
      ],
      map,
      { step: 1, minDuration: 0.04, ornament: 0 },
    )
    expect(dropped.map((n) => n.pitches[0])).toEqual([60])
  })

  it('absorbs slides and blips into the neighbour nearest in pitch', () => {
    // a 60 ms scoop (B3) into C4, a 50 ms blip (F4) after E4 falling back to it, an isolated short note
    const rows: NoteRow[] = [
      [0.44, 0.5, 59, 0.6],
      [0.5, 1, 60, 0.8],
      [1, 1.45, 64, 0.8],
      [1.45, 1.5, 65, 0.5],
      [1.5, 2, 52, 0.8],
      [2.5, 2.56, 67, 0.8],
    ]
    const out = quantizeVocal(rows, map, { step: 1, minDuration: 0.04 })
    expect(out.map((n) => [n.start, n.end, n.pitches[0]])).toEqual([
      [4, 8, 60], // the scoop's time went to C4 (its onset rounds to the beat)
      [8, 12, 64], // F4's 50 ms went to E4 (closer than E3)
      [12, 16, 52],
      [20, 21, 67], // nothing adjacent: kept
    ])
  })

  it('leans onsets to the eighth when they are about as close to it', () => {
    // onsets in sixteenths: 1.28 and 1.36 stay on the odd sixteenth; 1.44 (0.56 from the eighth vs
    // 0.44 from the sixteenth, within the 0.2 bias) moves to the eighth
    expect(quantizeVocal([[0.16, 0.5, 60, 0.8]], map, { step: 1 })[0].start).toBe(1)
    expect(quantizeVocal([[0.17, 0.5, 60, 0.8]], map, { step: 1 })[0].start).toBe(1)
    expect(quantizeVocal([[0.18, 0.5, 60, 0.8]], map, { step: 1 })[0].start).toBe(2)
  })

  it('uses an eighth grid in simplified mode and transposes', () => {
    const out = quantizeVocal([[0.13, 0.62, 60, 0.8]], map, { step: 2, transpose: 2 })
    expect(out).toEqual([{ start: 2, end: 6, pitches: [62], velocity: 0.8 }])
    expect(out[0].start % 2).toBe(0)
    expect((out[0].end - out[0].start) % 2).toBe(0)
  })

  it('drops notes outside the measures and very short blips', () => {
    const out = quantizeVocal(
      [
        [0.5, 0.52, 60, 0.8],
        [9, 10, 60, 0.8],
      ],
      map,
      { step: 1 },
    )
    expect(out).toEqual([])
    expect(map.totalTicks).toBe(16 * DIV)
  })

  it('medianPitch', () => {
    expect(medianPitch([])).toBeNull()
    expect(
      medianPitch([
        { start: 0, end: 1, pitches: [50], velocity: 1 },
        { start: 1, end: 2, pitches: [60], velocity: 1 },
        { start: 2, end: 3, pitches: [55], velocity: 1 },
      ]),
    ).toBe(55)
  })
})
