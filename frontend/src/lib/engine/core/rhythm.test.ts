import { describe, expect, it } from 'vitest'
import { addClick, rng } from '../testing/synth.ts'
import { chooseMeter, estimateTempo, onsetEnvelope, tempoFromBeats, trackBeats } from './rhythm.ts'
import { SR } from './spectrum.ts'

function clickTrack(bpm: number, seconds: number, start = 1.0): { y: Float32Array; clicks: number[] } {
  const y = new Float32Array(Math.round(seconds * SR))
  const random = rng(3)
  const clicks: number[] = []
  for (let t = start; t < seconds - 0.5; t += 60 / bpm) {
    addClick(y, SR, t, clicks.length % 4 === 0 ? 0.6 : 0.4, random)
    clicks.push(t)
  }
  return { y, clicks }
}

function fMeasure(est: number[], ref: number[], tol = 0.07): number {
  const used = new Set<number>()
  let hits = 0
  for (const r of ref) {
    const j = est.findIndex((e, k) => !used.has(k) && Math.abs(e - r) <= tol)
    if (j >= 0) {
      used.add(j)
      hits++
    }
  }
  const p = hits / Math.max(est.length, 1)
  const rc = hits / Math.max(ref.length, 1)
  return p + rc ? (2 * p * rc) / (p + rc) : 0
}

describe('beat tracking', () => {
  for (const bpm of [96, 120, 140]) {
    it(`locks onto a ${bpm} BPM click track`, () => {
      const { y, clicks } = clickTrack(bpm, 20)
      const env = onsetEnvelope(y)
      const tempo = estimateTempo(env)
      expect(tempo).toBeGreaterThan(bpm * 0.97)
      expect(tempo).toBeLessThan(bpm * 1.03)
      const beats = trackBeats(env, tempo)
      expect(fMeasure(beats, clicks)).toBeGreaterThan(0.95)
      expect(tempoFromBeats(beats)).toBeCloseTo(bpm, -0.5)
      for (let i = 1; i < beats.length; i++) expect(beats[i]).toBeGreaterThan(beats[i - 1])
    })
  }

  it('returns nothing for silence', () => {
    const env = onsetEnvelope(new Float32Array(5 * SR))
    expect(trackBeats(env, 120)).toEqual([])
  })
})

describe('meter', () => {
  const beats = Array.from({ length: 48 }, (_, i) => 1 + i * 0.5)
  it('puts downbeats where the chords change', () => {
    const changes = [2, 4, 6, 8, 10].map((b) => beats[b * 4 + 1]) // phase 1 of a 4-grid
    const { meter, downbeats } = chooseMeter(beats, changes)
    expect(meter).toBe(4)
    expect(downbeats[0]).toBe(beats[1])
  })
  it('recognizes 3/4 when changes follow a 3-beat grid', () => {
    const changes = [1, 2, 3, 5, 7, 9, 10, 13].map((b) => beats[b * 3])
    const { meter, downbeats } = chooseMeter(beats, changes)
    expect(meter).toBe(3)
    expect(downbeats[1] - downbeats[0]).toBeCloseTo(1.5)
  })
})
