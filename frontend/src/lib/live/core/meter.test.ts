import { describe, expect, it } from 'vitest'
import { LevelMeter } from './meter.ts'

const RATE = 48000

function sine(seconds: number, amplitude: number, rate = RATE): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < x.length; i++) x[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate)
  return x
}

describe('LevelMeter (recording without chord analysis)', () => {
  it('counts the input time and reports no chords, key or tempo', () => {
    const meter = new LevelMeter({ inputRate: RATE })
    meter.push(sine(1.5, 0.5))
    meter.push(sine(0.5, 0.5))
    expect(meter.time).toBeCloseTo(2, 9)
    const st = meter.state()
    expect(st.time).toBeCloseTo(2, 9)
    expect(st.finalized).toEqual([])
    expect(st.open).toEqual([])
    expect(st.key).toBeNull()
    expect(st.tempo).toBeNull()
    expect(meter.finish()).toEqual([])
  })

  it('reports the level since the previous state() on the -60..0 dBFS scale', () => {
    const meter = new LevelMeter({ inputRate: RATE })
    // a full-scale sine is -3 dBFS RMS: 57 / 60 of the meter
    meter.push(sine(0.1, 1))
    expect(meter.state().level).toBeCloseTo(0.95, 2)
    // a -40 dBFS RMS sine (amplitude 0.01 * sqrt 2): 20 / 60
    meter.push(sine(0.1, 0.01 * Math.SQRT2))
    expect(meter.state().level).toBeCloseTo(1 / 3, 2)
    // nothing since the last call, then silence, then non-finite samples: the floor
    expect(meter.state().level).toBe(0)
    meter.push(new Float32Array(4800))
    expect(meter.state().level).toBe(0)
    meter.push(new Float32Array([NaN, Infinity, -Infinity]))
    expect(meter.state().level).toBe(0)
  })

  it('ignores input after finish()', () => {
    const meter = new LevelMeter({ inputRate: RATE })
    meter.push(sine(1, 0.5))
    meter.finish()
    meter.push(sine(1, 0.5))
    expect(meter.time).toBeCloseTo(1, 9)
  })
})
