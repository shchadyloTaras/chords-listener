import { describe, expect, it } from 'vitest'
import { rng } from '../testing/synth.ts'
import { FFT, RealFFT, nextPow2 } from './fft.ts'
import { resample } from './resample.ts'

function naiveDft(re: ArrayLike<number>, im: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a)
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a)
    }
    outRe[k] = sr
    outIm[k] = si
  }
  return { re: outRe, im: outIm }
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>, n = a.length): number {
  let d = 0
  for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}

describe('FFT', () => {
  it('matches a naive DFT on random complex input', () => {
    const random = rng(1)
    for (const n of [2, 8, 64, 256]) {
      const re = Float64Array.from({ length: n }, () => random() * 2 - 1)
      const im = Float64Array.from({ length: n }, () => random() * 2 - 1)
      const ref = naiveDft(re, im)
      new FFT(n).transform(re, im)
      expect(maxAbsDiff(re, ref.re)).toBeLessThan(1e-9)
      expect(maxAbsDiff(im, ref.im)).toBeLessThan(1e-9)
    }
  })

  it('inverts exactly', () => {
    const random = rng(2)
    const n = 1024
    const x = Float64Array.from({ length: n }, () => random() - 0.5)
    const re = x.slice()
    const im = new Float64Array(n)
    const fft = new FFT(n)
    fft.transform(re, im)
    fft.inverse(re, im)
    expect(maxAbsDiff(re, x)).toBeLessThan(1e-12)
    expect(Math.max(...im.map(Math.abs))).toBeLessThan(1e-12)
  })

  it('puts a pure tone into its bin (Parseval holds)', () => {
    const n = 512
    const re = Float64Array.from({ length: n }, (_, t) => Math.cos((2 * Math.PI * 37 * t) / n))
    const im = new Float64Array(n)
    const energy = re.reduce((s, v) => s + v * v, 0)
    new FFT(n).transform(re, im)
    expect(Math.hypot(re[37], im[37])).toBeCloseTo(n / 2, 6)
    expect(Math.hypot(re[n - 37], im[n - 37])).toBeCloseTo(n / 2, 6)
    let spec = 0
    for (let k = 0; k < n; k++) spec += re[k] ** 2 + im[k] ** 2
    expect(spec / n).toBeCloseTo(energy, 6)
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(12)).toThrow(RangeError)
    expect(() => new RealFFT(1000)).toThrow(RangeError)
    expect(nextPow2(1000)).toBe(1024)
  })
})

describe('RealFFT', () => {
  it('matches a naive DFT of a real frame (spectrum and power)', () => {
    const random = rng(3)
    for (const n of [4, 16, 512, 2048]) {
      const x = Float64Array.from({ length: n }, () => random() * 2 - 1)
      const ref = naiveDft(x, new Float64Array(n))
      const re = new Float64Array(n / 2 + 1)
      const im = new Float64Array(n / 2 + 1)
      const fft = new RealFFT(n)
      fft.forward(x, re, im)
      expect(maxAbsDiff(re, ref.re, n / 2 + 1)).toBeLessThan(1e-8)
      expect(maxAbsDiff(im, ref.im, n / 2 + 1)).toBeLessThan(1e-8)
      const p = new Float64Array(n / 2 + 1)
      fft.power(Float32Array.from(x), p)
      // float32 input: compare relative to the frame's spectral scale
      const scale = Math.max(...p)
      for (let k = 0; k <= n / 2; k++) {
        expect(Math.abs(p[k] - (ref.re[k] ** 2 + ref.im[k] ** 2)) / scale).toBeLessThan(1e-5)
      }
    }
  })
})

describe('resample', () => {
  it('halves the rate without changing a tone', () => {
    const sr = 44100
    const x = Float32Array.from({ length: sr }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr))
    const y = resample(x, sr, 22050)
    expect(y.length).toBe(22050)
    let err = 0
    for (let i = 100; i < y.length - 100; i++) err = Math.max(err, Math.abs(y[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 22050)))
    expect(err).toBeLessThan(0.01)
  })

  it('removes content above the new Nyquist frequency', () => {
    const sr = 44100
    const x = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 15000 * i) / sr))
    const y = resample(x, sr, 22050)
    let rms = 0
    for (let i = 100; i < y.length - 100; i++) rms += y[i] ** 2
    expect(Math.sqrt(rms / (y.length - 200))).toBeLessThan(0.01)
  })

  it('is the identity when the rates match', () => {
    const x = new Float32Array([0.1, 0.2])
    expect(resample(x, 22050, 22050)).toBe(x)
  })
})
