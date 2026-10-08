import { describe, expect, it } from 'vitest'
import { buildBarGrid } from '../music/bars'
import {
  beatAt,
  beatIndexAt,
  buildPulseGrid,
  correctedTempo,
  effectiveRhythm,
  localTempo,
  lowerBound,
  normalizeFactor,
  tapRelation,
  TapTempo,
  tempoCurve,
  tempoFromBeats,
} from './index'

/** Evenly spaced beats at `bpm` starting at `start`. */
function grid(bpm: number, count: number, start = 0): number[] {
  const d = 60 / bpm
  return Array.from({ length: count }, (_, i) => +(start + i * d).toFixed(6))
}

describe('beat search', () => {
  const beats = [0.5, 1, 1.5, 2]

  it('lowerBound finds the first beat at or after x', () => {
    expect(lowerBound(beats, 0)).toBe(0)
    expect(lowerBound(beats, 1)).toBe(1)
    expect(lowerBound(beats, 1.2)).toBe(2)
    expect(lowerBound(beats, 9)).toBe(4)
  })

  it('beatIndexAt returns the last beat at or before t', () => {
    expect(beatIndexAt(beats, 0.2)).toBe(-1)
    expect(beatIndexAt(beats, 0.5)).toBe(0)
    expect(beatIndexAt(beats, 1.49)).toBe(1)
    expect(beatIndexAt(beats, 7)).toBe(3)
    expect(beatIndexAt([], 1)).toBe(-1)
  })

  it('beatAt gives the phase inside the beat and extrapolates after the last one', () => {
    expect(beatAt(beats, 0.1)).toEqual({ index: -1, phase: 0 })
    expect(beatAt(beats, 1.25)).toEqual({ index: 1, phase: 0.5 })
    expect(beatAt(beats, 2.25)).toEqual({ index: 3, phase: 0.5 })
    expect(beatAt(beats, 5).phase).toBe(1)
  })
})

describe('tempo estimation', () => {
  it('global tempo is 60 / median interval and ignores glitches', () => {
    expect(tempoFromBeats(grid(120, 16))).toBeCloseTo(120, 6)
    const glitchy = [...grid(100, 10), 6.1, 6.15, ...grid(100, 10, 7)]
    expect(tempoFromBeats(glitchy)).toBeCloseTo(100, 0)
    expect(tempoFromBeats([1])).toBeNull()
  })

  it('local tempo follows a tempo change', () => {
    const slow = grid(90, 24)
    const fast = grid(120, 24, slow[slow.length - 1] + 0.5)
    const beats = [...slow, ...fast]
    expect(localTempo(beats, 5)).toBeCloseTo(90, 0)
    expect(localTempo(beats, fast[12])).toBeCloseTo(120, 0)
    // before the first beat / after the last one: nearest window
    expect(localTempo(beats, -3)).toBeCloseTo(90, 0)
    expect(localTempo(beats, 999)).toBeCloseTo(120, 0)
  })

  it('local tempo shrugs off a single missed beat', () => {
    const beats = grid(120, 20)
    beats.splice(10, 1) // tracker dropped one beat → one interval is doubled
    expect(localTempo(beats, beats[9])).toBeCloseTo(120, 0)
  })

  it('local tempo needs at least a few beats', () => {
    expect(localTempo([0, 0.5], 0.2)).toBeNull()
  })

  it('tempo curve samples the whole song', () => {
    const beats = [...grid(90, 30), ...grid(120, 30, 20.5)]
    const curve = tempoCurve(beats, 36, 10)
    expect(curve).toHaveLength(10)
    expect(curve[0].t).toBe(0)
    expect(curve[9].t).toBe(36)
    expect(curve[0].bpm).toBeCloseTo(90, 0)
    expect(curve[9].bpm).toBeCloseTo(120, 0)
    expect(tempoCurve([], 10)).toEqual([])
  })

  it('tempo curve samples only start..duration of a fragment of a long video', () => {
    const beats = [...grid(90, 30, 2000), ...grid(120, 30, 2020.5)]
    const curve = tempoCurve(beats, 2036, 10, 2000)
    expect(curve).toHaveLength(10)
    expect(curve[0].t).toBe(2000)
    expect(curve[9].t).toBe(2036)
    expect(curve[0].bpm).toBeCloseTo(90, 0)
    expect(curve[9].bpm).toBeCloseTo(120, 0)
    expect(curve.filter((p) => p.bpm < 100)).toHaveLength(curve.filter((p) => p.t < 2020).length)
  })
})

describe('tempo correction', () => {
  const beats = grid(60, 17, 1) // 1..17 s, a beat per second
  const downbeats = beats.filter((_, i) => i % 4 === 1) // pickup: first downbeat on beat #1 (t = 2)

  it('normalizes stored factors', () => {
    expect(normalizeFactor(2)).toBe(2)
    expect(normalizeFactor(0.5)).toBe(0.5)
    expect(normalizeFactor(3)).toBe(1)
    expect(normalizeFactor(undefined)).toBe(1)
    expect(correctedTempo(100, 2)).toBe(200)
    expect(correctedTempo(100, 'x')).toBe(100)
    expect(correctedTempo(null, 2)).toBeNull()
  })

  it('×1 returns the detection unchanged', () => {
    const r = effectiveRhythm({ beats, downbeats, tempo: 60, timeSignature: 4 }, 1)
    expect(r.beats).toBe(beats)
    expect(r.downbeats).toBe(downbeats)
    expect(r.tempo).toBe(60)
    expect(r.detectedTempo).toBe(60)
    expect(r.timeSignature).toBe(4)
  })

  it('×2 inserts midpoints and recomputes downbeats from the first one', () => {
    const r = effectiveRhythm({ beats, downbeats, tempo: 60, timeSignature: 4, duration: 30 }, 2)
    expect(r.tempo).toBe(120)
    expect(r.detectedTempo).toBe(60)
    expect(r.beats.slice(0, 5)).toEqual([1, 1.5, 2, 2.5, 3])
    // 17 beats → 16 midpoints + one off-beat after the last beat
    expect(r.beats).toHaveLength(34)
    expect(r.beats[r.beats.length - 1]).toBe(17.5)
    expect(r.downbeats.slice(0, 4)).toEqual([2, 4, 6, 8])
  })

  it('×½ keeps every other beat, in step with the first downbeat', () => {
    const r = effectiveRhythm({ beats, downbeats, tempo: 60, timeSignature: 4 }, 0.5)
    expect(r.tempo).toBe(30)
    // first downbeat (t = 2) is beat #1 → keep odd beats
    expect(r.beats.slice(0, 3)).toEqual([2, 4, 6])
    expect(r.downbeats).toEqual([2, 10])
  })

  it('×2 halves the bar length in the bar grid, ×½ doubles it', () => {
    const song = grid(100, 200, 0.3)
    const downs = song.filter((_, i) => i % 4 === 0)
    const input = { beats: song, downbeats: downs, tempo: 100, timeSignature: 4, duration: 121 }
    const bar = (f: 0.5 | 1 | 2) => {
      const r = effectiveRhythm(input, f)
      const frames = buildBarGrid({ ...input, beats: r.beats, downbeats: r.downbeats, tempo: r.tempo })
      return frames[5].end - frames[5].start
    }
    expect(bar(1)).toBeCloseTo(2.4, 2)
    expect(bar(2)).toBeCloseTo(1.2, 2)
    expect(bar(0.5)).toBeCloseTo(4.8, 2)
  })

  it('works without downbeats and without beats', () => {
    const r2 = effectiveRhythm({ beats, tempo: 60 }, 2)
    expect(r2.downbeats).toEqual([])
    const noBeats = effectiveRhythm({ downbeats: [0, 2, 4, 6], tempo: 120 }, 2)
    expect(noBeats.downbeats).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(effectiveRhythm({ downbeats: [0, 2, 4, 6], tempo: 120 }, 0.5).downbeats).toEqual([0, 4])
    expect(effectiveRhythm({ tempo: null }, 2).tempo).toBeNull()
  })

  it('falls back to the beats when the tempo is missing', () => {
    expect(effectiveRhythm({ beats: grid(80, 12), tempo: 0 }, 1).tempo).toBeCloseTo(80, 6)
    expect(effectiveRhythm({ beats: grid(80, 12), tempo: null }, 2).tempo).toBeCloseTo(160, 6)
  })
})

describe('pulse grid', () => {
  const bars = [
    { start: 0, end: 1, boundaries: [0, 0.5, 1], pickup: true }, // 2-beat pickup
    { start: 1, end: 3, boundaries: [1, 1.5, 2, 2.5, 3] },
    { start: 3, end: 5, boundaries: [3, 3.5, 4, 4.5, 5] },
  ]

  it('labels beats with their position in the bar (pickup right-aligned)', () => {
    const beats = [0, 0.5, 1, 1.5, 2, 2.5, 2.98, 3.5, 4, 4.5]
    const g = buildPulseGrid(beats, bars, 4)
    expect(g.meter).toBe(4)
    expect(g.times).toEqual(beats)
    expect(g.pos).toEqual([2, 3, 0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('uses the bar boundaries when there are no beats', () => {
    const g = buildPulseGrid([], bars, 4)
    expect(g.times).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5])
    expect(g.pos).toEqual([2, 3, 0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('wraps long bars and handles an empty grid', () => {
    const long = [{ start: 0, end: 3, boundaries: [0, 0.5, 1, 1.5, 2, 2.5, 3] }]
    expect(buildPulseGrid([], long, 3).pos).toEqual([0, 1, 2, 0, 1, 2])
    expect(buildPulseGrid([1, 2], [], 4).times).toEqual([])
  })
})

describe('tap tempo', () => {
  it('needs two taps, then reports the median interval', () => {
    const tap = new TapTempo()
    expect(tap.tap(1000)).toEqual({ bpm: null, count: 1 })
    expect(tap.tap(1500).bpm).toBeCloseTo(120)
    tap.tap(2000)
    tap.tap(2700) // one sloppy tap
    const r = tap.tap(3200)
    expect(r.count).toBe(5)
    expect(r.bpm).toBeCloseTo(120)
  })

  it('starts a new series after a 2 s pause', () => {
    const tap = new TapTempo()
    tap.tap(0)
    tap.tap(400)
    expect(tap.expired(2300)).toBe(false)
    expect(tap.expired(2500)).toBe(true)
    expect(tap.tap(2500)).toEqual({ bpm: null, count: 1 })
    expect(tap.tap(3500).bpm).toBeCloseTo(60)
  })

  it('keeps only the most recent taps and ignores bounces', () => {
    const tap = new TapTempo({ maxTaps: 4 })
    for (let i = 0; i < 6; i++) tap.tap(i * 1000) // 60 BPM
    for (let i = 1; i <= 4; i++) tap.tap(5000 + i * 500) // 120 BPM
    expect(tap.reading().bpm).toBeCloseTo(120)
    expect(tap.tap(7020).count).toBe(4) // 20 ms after the previous tap → ignored
    tap.reset()
    expect(tap.reading()).toEqual({ bpm: null, count: 0 })
  })

  it('relates a tapped tempo to the detected one', () => {
    expect(tapRelation(118, 120)).toBe('match')
    expect(tapRelation(232, 116)).toBe('double')
    expect(tapRelation(60, 121)).toBe('half')
    expect(tapRelation(90, 120)).toBe('other')
    expect(tapRelation(90, 0)).toBe('other')
  })
})
