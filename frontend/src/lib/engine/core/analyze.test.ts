import { describe, expect, it } from 'vitest'
import { renderProgression, type ProgressionChord } from '../testing/synth.ts'
import { ENGINE_LABEL, analyzeSignal } from './analyze.ts'
import { PITCH_NAMES, parseLabel } from './chords.ts'
import { resample } from './resample.ts'
import { SR } from './spectrum.ts'
import type { BrowserAnalysis } from './types.ts'

// C - G - Am - F, twice; one chord per bar of 4 beats at 120 BPM
const PROGRESSION: { label: string; chord: ProgressionChord }[] = [
  { label: 'C', chord: { notes: [60, 64, 67], bass: 36 } },
  { label: 'G', chord: { notes: [59, 62, 67], bass: 43 } },
  { label: 'Am', chord: { notes: [57, 60, 64], bass: 45 } },
  { label: 'F', chord: { notes: [57, 60, 65], bass: 41 } },
]
const SONG = [...PROGRESSION, ...PROGRESSION]
const LABEL_RE = /^(N|[A-G]#?(m|7|maj7|m7|dim|aug|sus2|sus4|dim7|m7b5|6|m6|9|add9)?(\/[A-G]#?)?)$/

function render() {
  return renderProgression(SONG.map((s) => s.chord), { sr: SR, bpm: 120, beatsPerChord: 4, leadIn: 0.6, tail: 1.2 })
}

function labelAt(res: BrowserAnalysis, t: number): string {
  return res.chords.find((c) => c.start <= t && t < c.end)?.label ?? 'N'
}

function checkContract(res: BrowserAnalysis, duration: number): void {
  expect(res.duration).toBeCloseTo(duration, 2)
  expect(res.chords.length).toBeGreaterThan(0)
  expect(res.chords[0].start).toBe(0)
  expect(res.chords[res.chords.length - 1].end).toBe(res.duration)
  res.chords.forEach((c, i) => {
    expect(c.end).toBeGreaterThan(c.start)
    if (i > 0) expect(c.start).toBe(res.chords[i - 1].end)
    expect(c.label).toMatch(LABEL_RE)
    expect(c.confidence).toBeGreaterThanOrEqual(0)
    expect(c.confidence).toBeLessThanOrEqual(1)
    if (c.label === 'N') {
      expect([c.root, c.quality, c.bass]).toEqual([null, null, null])
    } else {
      const parsed = parseLabel(c.label)
      expect(c.root).toBe(PITCH_NAMES[parsed.root!])
      expect(c.quality).toBe(parsed.quality)
      expect(c.bass ?? null).toBe(parsed.bass === null ? null : PITCH_NAMES[parsed.bass])
    }
  })
  expect(res.waveform).toHaveLength(1200)
  expect(Math.max(...res.waveform)).toBeLessThanOrEqual(1)
  expect(Math.min(...res.waveform)).toBeGreaterThanOrEqual(0)
  for (const list of [res.beats, res.downbeats]) {
    list.forEach((b, i) => {
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(res.duration)
      if (i > 0) expect(b).toBeGreaterThan(list[i - 1])
    })
  }
  for (const d of res.downbeats) expect(res.beats).toContain(d)
  expect([3, 4]).toContain(res.timeSignature)
  expect(res.tempo).toBeGreaterThan(0)
  expect(PITCH_NAMES as readonly string[]).toContain(res.key.tonic)
  expect(res.key.name).toBe(res.key.tonic + (res.key.mode === 'minor' ? 'm' : ''))
  expect(res.engine).toBe(ENGINE_LABEL)
  // plain JSON (structured-clone / postMessage safe), camelCase keys only
  expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  expect(Object.keys(res).sort()).toEqual(
    ['beats', 'chords', 'downbeats', 'duration', 'engine', 'key', 'tempo', 'timeSignature', 'waveform'],
  )
}

describe('analyzeSignal (end to end)', () => {
  const song = render()
  const res = analyzeSignal(song.audio, SR)

  it('returns the engine contract shape with contiguous segments', () => {
    checkContract(res, song.duration)
  })

  it('recognizes C - G - Am - F', () => {
    SONG.forEach((s, i) => {
      const a = song.changes[i]
      const b = i + 1 < SONG.length ? song.changes[i + 1] : a + 2
      // the middle of every bar carries the right chord
      for (const f of [0.25, 0.5, 0.75]) expect(labelAt(res, a + f * (b - a))).toBe(s.label)
    })
    expect(labelAt(res, 0.2)).toBe('N') // silent lead-in
    expect(labelAt(res, song.duration - 0.2)).toBe('N') // silent tail
    expect(res.key.name).toBe('C')
  })

  it('places chord changes on the beat grid', () => {
    for (const t of song.changes.slice(1)) {
      const nearest = res.chords.reduce((d, c) => Math.min(d, Math.abs(c.start - t)), Infinity)
      expect(nearest).toBeLessThan(0.12)
    }
  })

  it('tracks the 120 BPM beat', () => {
    expect(res.tempo).toBeGreaterThan(116)
    expect(res.tempo).toBeLessThan(124)
    const hits = song.beats.filter((b) => res.beats.some((e) => Math.abs(e - b) < 0.07)).length
    expect(hits / song.beats.length).toBeGreaterThan(0.9)
    expect(res.timeSignature).toBe(4)
  })

  it('gives the same chords from 44.1 kHz input', () => {
    const hi = resample(song.audio, SR, 44100)
    const res44 = analyzeSignal(hi, 44100)
    checkContract(res44, song.duration)
    expect(res44.chords.map((c) => c.label)).toEqual(res.chords.map((c) => c.label))
  })

  it('reports monotonic progress up to 1', () => {
    const seen: number[] = []
    analyzeSignal(song.audio.subarray(0, 4 * SR), SR, { onProgress: (f) => seen.push(f) })
    expect(seen.length).toBeGreaterThan(3)
    seen.forEach((f, i) => i > 0 && expect(f).toBeGreaterThanOrEqual(seen[i - 1]))
    expect(seen[seen.length - 1]).toBe(1)
  })
})

describe('analyzeSignal (edge cases)', () => {
  it('reports silence as one N segment', () => {
    const res = analyzeSignal(new Float32Array(3 * SR), SR)
    checkContract(res, 3)
    expect(res.chords).toEqual([{ start: 0, end: 3, label: 'N', root: null, quality: null, bass: null, confidence: 1 }])
  })

  it('handles clips shorter than half a second', () => {
    const y = Float32Array.from({ length: SR / 4 }, (_, i) => Math.sin(i / 10))
    const res = analyzeSignal(y, SR)
    checkContract(res, 0.25)
    expect(res.chords.map((c) => c.label)).toEqual(['N'])
  })

  it('ignores non-finite samples', () => {
    const song = render()
    const y = song.audio.slice()
    for (let i = 0; i < y.length; i += 997) y[i] = i % 2 ? NaN : Infinity
    const res = analyzeSignal(y, SR)
    checkContract(res, song.duration)
    expect(labelAt(res, song.changes[2] + 1)).toBe('Am')
  })

  it('handles empty input', () => {
    const res = analyzeSignal(new Float32Array(0), SR)
    expect(res.duration).toBe(0)
    expect(res.chords).toEqual([])
    expect(res.waveform).toHaveLength(1200)
  })
})
