// Band-limited resampling (windowed-sinc, table-driven). The browser normally decodes
// straight to the analysis rate; this is the fallback and what Node-side tools use.

const PHASES = 256

function blackman(x: number): number {
  // x in [-1, 1]
  const a = Math.PI * (x + 1)
  return 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-12) return 1
  const a = Math.PI * x
  return Math.sin(a) / a
}

/** Resample mono audio from `srIn` to `srOut` Hz. Returns the input itself when the rates match. */
export function resample(x: Float32Array, srIn: number, srOut: number): Float32Array {
  if (srIn === srOut || x.length === 0) return x
  const ratio = srOut / srIn
  const nOut = Math.max(1, Math.round(x.length * ratio))
  const out = new Float32Array(nOut)
  // cutoff in cycles per input sample, a little below the lower Nyquist
  const fc = 0.5 * Math.min(1, ratio) * 0.94
  const half = Math.ceil(12 / Math.min(1, ratio)) // taps on each side
  const taps = 2 * half
  // table[p][j] = h(p / PHASES - (j - half + 1)), j = 0..taps-1
  const table = new Float32Array((PHASES + 1) * taps)
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES
    let sum = 0
    for (let j = 0; j < taps; j++) {
      const tau = frac - (j - half + 1)
      const v = 2 * fc * sinc(2 * fc * tau) * blackman(tau / (half + 1))
      table[p * taps + j] = v
      sum += v
    }
    // unity DC gain at every phase
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum
  }
  const n = x.length
  const step = srIn / srOut
  for (let i = 0; i < nOut; i++) {
    const t = i * step
    let i0 = Math.floor(t)
    let p = Math.round((t - i0) * PHASES)
    if (p === PHASES) {
      p = 0
      i0 += 1
    }
    const base = p * taps
    const first = i0 - half + 1
    let acc = 0
    if (first >= 0 && first + taps <= n) {
      for (let j = 0; j < taps; j++) acc += x[first + j] * table[base + j]
    } else {
      for (let j = 0; j < taps; j++) {
        const k = first + j
        if (k >= 0 && k < n) acc += x[k] * table[base + j]
      }
    }
    out[i] = acc
  }
  return out
}
