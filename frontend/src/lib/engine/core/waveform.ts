// Signal summaries: waveform peaks for the player and frame loudness for silence detection.

/** `n` peak values in 0..1 (normalized to the loudest bin), rounded to 4 decimals. */
export function waveformPeaks(x: Float32Array, n = 1200): number[] {
  const len = x.length
  if (len === 0) return new Array<number>(n).fill(0)
  const peaks = new Float64Array(n)
  if (len >= n) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i * len) / n)
      const b = Math.floor(((i + 1) * len) / n)
      let m = 0
      for (let k = a; k < b; k++) {
        const v = Math.abs(x[k])
        if (v > m) m = v
      }
      peaks[i] = m
    }
  } else {
    for (let i = 0; i < n; i++) peaks[i] = Math.abs(x[Math.floor((i * len) / n)])
  }
  let top = 0
  for (let i = 0; i < n; i++) if (peaks[i] > top) top = peaks[i]
  if (top <= 1e-6) return new Array<number>(n).fill(0)
  return Array.from(peaks, (v) => Math.round(Math.min(1, v / top) * 1e4) / 1e4)
}

/** RMS level (dBFS) of `win`-second windows centered on frames t / fps. */
export function frameRmsDb(x: Float32Array, sr: number, fps: number, T: number, win = 0.2): Float64Array {
  const out = new Float64Array(T)
  const hop = sr / fps
  const half = Math.floor((win * sr) / 2)
  for (let t = 0; t < T; t++) {
    const c = Math.floor(t * hop)
    const lo = Math.max(0, Math.min(x.length, c - half))
    const hi = Math.max(0, Math.min(x.length, c + half))
    let e = 0
    for (let k = lo; k < hi; k++) e += x[k] * x[k]
    e /= Math.max(hi - lo, 1)
    out[t] = 10 * Math.log10(e + 1e-12)
  }
  return out
}
