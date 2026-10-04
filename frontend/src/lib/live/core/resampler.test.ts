import { describe, expect, it } from 'vitest'
import { resample } from '../../engine/core/resample.ts'
import { rng } from '../../engine/testing/synth.ts'
import { StreamingResampler } from './resampler.ts'

function signal(n: number, seed: number): Float32Array {
  const r = rng(seed)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(i * 0.031) + 0.3 * Math.sin(i * 0.41 + 1) + 0.2 * (r() - 0.5)
  return x
}

function streamed(x: Float32Array, srIn: number, srOut: number, seed: number): Float32Array {
  const r = rng(seed)
  const rs = new StreamingResampler(srIn, srOut)
  const parts: Float32Array[] = []
  for (let i = 0; i < x.length; ) {
    const n = 1 + Math.floor(r() * 5000)
    parts.push(rs.push(x.subarray(i, i + n)))
    i += n
  }
  parts.push(rs.flush())
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe('StreamingResampler', () => {
  for (const [srIn, srOut] of [[48000, 22050], [44100, 22050], [22050, 11025], [16000, 22050]] as const) {
    it(`matches the offline resampler sample for sample (${srIn} -> ${srOut} Hz, random chunks)`, () => {
      const x = signal(Math.round(2.3 * srIn) + 17, srIn)
      const ref = resample(x, srIn, srOut)
      const out = streamed(x, srIn, srOut, srOut)
      expect(out.length).toBe(ref.length)
      let maxErr = 0
      for (let i = 0; i < ref.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - ref[i]))
      expect(maxErr).toBe(0)
    })
  }

  it('passes audio through at equal rates', () => {
    const x = signal(5000, 3)
    const rs = new StreamingResampler(22050, 22050)
    expect(Array.from(rs.push(x))).toEqual(Array.from(x))
    expect(rs.flush().length).toBe(0)
  })

  it('emits output with a short, bounded delay', () => {
    const rs = new StreamingResampler(48000, 22050)
    let produced = 0
    for (let i = 0; i < 100; i++) {
      produced += rs.push(new Float32Array(480)).length
      const due = ((i + 1) * 480 * 22050) / 48000
      // the kernel needs ~12 output samples (~0.5 ms) of look-ahead
      expect(due - produced).toBeLessThan(16)
      expect(due - produced).toBeGreaterThan(0)
    }
  })
})
