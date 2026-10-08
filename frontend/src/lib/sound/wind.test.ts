import { describe, expect, it } from 'vitest'
import { midiToFreq } from './dsp'
import { renderWind, WIND_LOOP_START, WIND_MODELS, WIND_RMS, windLoop, windOnset, windParams, windSpectrum, type WindInstrument } from './wind'

const fs = 16000

/** Amplitude of the component at `freq` (Hann-windowed DFT over [from, from + seconds)). */
function amplitude(x: Float32Array, freq: number, from: number, seconds: number): number {
  const a = Math.round(from * fs)
  const n = Math.round(seconds * fs)
  let re = 0
  let im = 0
  let ws = 0
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
    re += x[a + i] * w * Math.cos((2 * Math.PI * freq * i) / fs)
    im += x[a + i] * w * Math.sin((2 * Math.PI * freq * i) / fs)
    ws += w
  }
  return (2 * Math.hypot(re, im)) / ws
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0
  const a = Math.round(from * fs)
  const b = Math.min(x.length, Math.round(to * fs))
  for (let i = a; i < b; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, b - a))
}

const render = (instrument: WindInstrument, midi: number) => renderWind(windParams(instrument, midi, fs))
const range: Record<WindInstrument, number[]> = { sopilka: [72, 79, 86, 93], flute: [60, 67, 74, 81, 88] }

describe.each(['sopilka', 'flute'] as const)('%s notes', (instrument) => {
  const model = WIND_MODELS[instrument]

  it('are the attack then exactly one steady loop of whole periods', () => {
    for (const m of range[instrument]) {
      const loop = windLoop(m, fs)
      const x = render(instrument, m)
      expect(x.length).toBe(loop.start + loop.length)
      expect(loop.start / fs).toBeCloseTo(WIND_LOOP_START, 3)
      // a whole number of periods, a tiny fraction of a cent off
      expect(Math.abs(1200 * Math.log2(loop.freq / midiToFreq(m)))).toBeLessThan(0.1)
      expect(Math.abs(loop.length / fs - 1.6)).toBeLessThan(0.01)
    }
  })

  it('loop without a seam: jumping from the end back to the loop start continues the waveform', () => {
    for (const m of range[instrument]) {
      const loop = windLoop(m, fs)
      const x = render(instrument, m)
      // the step across the seam is no bigger than the steps inside the loop
      let maxStep = 0
      for (let i = loop.start + 1; i < x.length; i++) maxStep = Math.max(maxStep, Math.abs(x[i] - x[i - 1]))
      const seam = Math.abs(x[loop.start] - x[x.length - 1])
      expect(seam).toBeLessThanOrEqual(maxStep * 1.05)
    }
  })

  it('are in tune and have the measured spectrum', () => {
    // held dead steady, so the DFT sees clean lines
    const steady = { ...model, vibratoCents: 0, vibratoAm: 0, wanderCents: 0, wanderDb: 0 }
    for (const m of range[instrument]) {
      const x = renderWind(windParams(instrument, m, fs), steady)
      const f = midiToFreq(m)
      const levels = windSpectrum(model, m)
      const h1 = amplitude(x, f, 1, 0.8)
      // nothing between the harmonics but breath
      expect(amplitude(x, f * 1.5, 1, 0.8)).toBeLessThan(h1 * 0.05)
      for (let k = 2; k <= 3; k++) {
        if (k * f > 7000 || levels[k - 1] < -40) continue
        const measured = 20 * Math.log10(amplitude(x, k * f, 1, 0.8) / h1)
        expect(Math.abs(measured - (levels[k - 1] - levels[0]))).toBeLessThan(3)
      }
    }
  })

  it('start from silence, build up within the attack and breathe under the tone', () => {
    const x = render(instrument, range[instrument][1])
    expect(Math.abs(x[0])).toBeLessThan(1e-3)
    expect(rms(x, 0, 0.004)).toBeLessThan(rms(x, 0.8, 1.6) * 0.5)
    expect(rms(x, 0.15, 0.3)).toBeGreaterThan(rms(x, 0.8, 1.6) * 0.7)
    expect(windOnset(0, 0.05)).toBe(0)
    expect(windOnset(0.08, 0.05)).toBe(1)
  })

  it('are deterministic, clean and level across the range', () => {
    const m0 = range[instrument][1]
    expect(render(instrument, m0)).toEqual(render(instrument, m0))
    for (const m of range[instrument]) {
      const x = render(instrument, m)
      let peak = 0
      for (const v of x) {
        expect(Number.isFinite(v)).toBe(true)
        peak = Math.max(peak, Math.abs(v))
      }
      expect(peak).toBeLessThan(0.9)
      const db = 20 * Math.log10(rms(x, 0.8, 2.3) / WIND_RMS)
      expect(Math.abs(db)).toBeLessThan(4)
    }
  })
})
