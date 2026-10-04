// Radix-2 FFTs with precomputed tables (reused across frames: allocate once, transform many).

function assertPowerOfTwo(n: number): void {
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
    throw new RangeError(`FFT size must be a power of two >= 2, got ${n}`)
  }
}

/** In-place iterative complex FFT: X[k] = sum_n x[n] e^{-2 pi i k n / N}. */
export class FFT {
  readonly size: number
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(size: number) {
    assertPowerOfTwo(size)
    this.size = size
    const bits = Math.round(Math.log2(size))
    this.rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      let x = i
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1)
        x >>= 1
      }
      this.rev[i] = r
    }
    const half = size >> 1
    this.cos = new Float64Array(half)
    this.sin = new Float64Array(half)
    for (let i = 0; i < half; i++) {
      const a = (2 * Math.PI * i) / size
      this.cos[i] = Math.cos(a)
      this.sin[i] = -Math.sin(a)
    }
  }

  /** Forward transform of (re, im) in place. Both arrays must have length `size`. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    const cos = this.cos
    const sin = this.sin
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j
          const b = a + half
          const wr = cos[k]
          const wi = sin[k]
          const br = re[b]
          const bi = im[b]
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }

  /** Inverse transform in place (scaled by 1/N). */
  inverse(re: Float64Array, im: Float64Array): void {
    const n = this.size
    for (let i = 0; i < n; i++) im[i] = -im[i]
    this.transform(re, im)
    const s = 1 / n
    for (let i = 0; i < n; i++) {
      re[i] *= s
      im[i] = -im[i] * s
    }
  }
}

/** FFT of a real frame of length N via one complex FFT of length N/2. */
export class RealFFT {
  readonly size: number
  private readonly fft: FFT
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly wr: Float64Array
  private readonly wi: Float64Array

  constructor(size: number) {
    assertPowerOfTwo(size)
    if (size < 4) throw new RangeError('RealFFT size must be >= 4')
    this.size = size
    const m = size >> 1
    this.fft = new FFT(m)
    this.re = new Float64Array(m)
    this.im = new Float64Array(m)
    this.wr = new Float64Array(m + 1)
    this.wi = new Float64Array(m + 1)
    for (let k = 0; k <= m; k++) {
      const a = (2 * Math.PI * k) / size
      this.wr[k] = Math.cos(a)
      this.wi[k] = -Math.sin(a)
    }
  }

  /**
   * Spectrum X[k], k = 0..N/2, of the real frame `x` (length N).
   * `outRe` / `outIm` must have length >= N/2 + 1.
   */
  forward(x: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    this.pack(x)
    const m = this.size >> 1
    const re = this.re
    const im = this.im
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const zr = re[k1]
      const zi = im[k1]
      const cr = re[k2]
      const ci = -im[k2]
      const er = 0.5 * (zr + cr)
      const ei = 0.5 * (zi + ci)
      const or = 0.5 * (zi - ci)
      const oi = -0.5 * (zr - cr)
      const wr = this.wr[k]
      const wi = this.wi[k]
      outRe[k] = er + wr * or - wi * oi
      outIm[k] = ei + wr * oi + wi * or
    }
  }

  /** Power spectrum |X[k]|^2, k = 0..N/2, of the real frame `x` (length N). */
  power(x: ArrayLike<number>, out: Float64Array | Float32Array): void {
    this.pack(x)
    const m = this.size >> 1
    const re = this.re
    const im = this.im
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const zr = re[k1]
      const zi = im[k1]
      const cr = re[k2]
      const ci = -im[k2]
      const er = 0.5 * (zr + cr)
      const ei = 0.5 * (zi + ci)
      const or = 0.5 * (zi - ci)
      const oi = -0.5 * (zr - cr)
      const wr = this.wr[k]
      const wi = this.wi[k]
      const xr = er + wr * or - wi * oi
      const xi = ei + wr * oi + wi * or
      out[k] = xr * xr + xi * xi
    }
  }

  private pack(x: ArrayLike<number>): void {
    const m = this.size >> 1
    const re = this.re
    const im = this.im
    for (let k = 0; k < m; k++) {
      re[k] = x[2 * k]
      im[k] = x[2 * k + 1]
    }
    this.fft.transform(re, im)
  }
}

/** Periodic Hann window (the usual analysis window for STFTs). */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

export function nextPow2(n: number): number {
  let p = 2
  while (p < n) p <<= 1
  return p
}
