import { describe, expect, it } from 'vitest'
import type { KeyInfo } from '../../types'
import { DRONE_CROSSFADE, DRONE_LOOP_END, DRONE_LOOP_START, droneLoop, droneMidi } from './drone'
import { harmoniumParams, renderHarmonium } from './harmonium'

const key = (tonic: string, mode: 'major' | 'minor' = 'major'): KeyInfo => ({ tonic, mode, name: tonic + (mode === 'minor' ? 'm' : ''), confidence: 0.8 })

describe('drone key', () => {
  it('holds the song tonic in the harmonium lowest octave (C3–B3)', () => {
    expect(droneMidi(key('A', 'minor'), 0)).toBe(57) // A3
    expect(droneMidi(key('C'), 0)).toBe(48) // C3
    expect(droneMidi(key('B'), 0)).toBe(59) // B3
    expect(droneMidi(key('F#'), 0)).toBe(54)
  })

  it('follows the transposition, staying in that octave', () => {
    expect(droneMidi(key('A', 'minor'), 2)).toBe(59) // Bm → B3
    expect(droneMidi(key('A', 'minor'), 3)).toBe(48) // Cm → C3
    expect(droneMidi(key('C'), -1)).toBe(59) // B
  })

  it('has no key without the song key', () => {
    expect(droneMidi(null, 0)).toBeNull()
    expect(droneMidi(undefined, 5)).toBeNull()
  })
})

describe('drone loop', () => {
  const fs = 22050
  const x = renderHarmonium(harmoniumParams(57, 5, fs))
  const y = droneLoop(x, fs)
  const a = Math.round(DRONE_LOOP_START * fs)

  it('ends at the loop end and keeps the reed speaking untouched before the crossfade', () => {
    expect(y.length).toBe(Math.round(DRONE_LOOP_END * fs))
    const f = Math.round(DRONE_CROSSFADE * fs)
    for (const i of [0, 100, a, y.length - f - 1]) expect(y[i]).toBe(x[i])
  })

  it('wraps from the loop end to the loop start without a click', () => {
    // the jump back: the last sample of the loop is followed by the sample at the loop start
    const steps: number[] = []
    for (let i = a + 1; i < y.length; i++) steps.push(Math.abs(y[i] - y[i - 1]))
    steps.sort((p, q) => p - q)
    const typical = steps[Math.floor(steps.length * 0.99)]
    expect(Math.abs(y[a] - y[y.length - 1])).toBeLessThanOrEqual(typical)
    // it ends on the samples just before the loop start
    expect(y[y.length - 1]).toBeCloseTo(x[a - 1], 6)
  })
})
