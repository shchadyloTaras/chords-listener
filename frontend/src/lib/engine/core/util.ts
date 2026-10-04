// Small numeric helpers on typed arrays.

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** Median of the values (copies; NaN-free input expected). */
export function median(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return 0
  const a = Float64Array.from(values).sort()
  const h = n >> 1
  return n % 2 ? a[h] : 0.5 * (a[h - 1] + a[h])
}

/** Linear-interpolated percentile (q in 0..100), like numpy's default. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const n = values.length
  if (n === 0) return 0
  const a = Float64Array.from(values).sort()
  const pos = (clamp(q, 0, 100) / 100) * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(n - 1, lo + 1)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

export function mean(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return 0
  let s = 0
  for (let i = 0; i < n; i++) s += values[i]
  return s / n
}

/** Sample standard deviation (ddof = 1). */
export function std(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 2) return 0
  const m = mean(values)
  let s = 0
  for (let i = 0; i < n; i++) s += (values[i] - m) ** 2
  return Math.sqrt(s / (n - 1))
}

/**
 * Median filter along time of a row-major (T x D) matrix, window `size` (odd),
 * edges handled like scipy's mode="nearest". Returns a new array.
 */
export function medianFilterTime(x: Float32Array, T: number, D: number, size: number): Float32Array {
  const out = new Float32Array(x.length)
  if (size <= 1 || T < size) {
    out.set(x)
    return out
  }
  const h = size >> 1
  const buf = new Float64Array(size)
  for (let d = 0; d < D; d++) {
    for (let t = 0; t < T; t++) {
      for (let k = -h; k <= h; k++) {
        const tt = t + k < 0 ? 0 : t + k >= T ? T - 1 : t + k
        buf[k + h] = x[tt * D + d]
      }
      // insertion sort of a tiny window
      for (let i = 1; i < size; i++) {
        const v = buf[i]
        let j = i - 1
        while (j >= 0 && buf[j] > v) {
          buf[j + 1] = buf[j]
          j--
        }
        buf[j + 1] = v
      }
      out[t * D + d] = buf[h]
    }
  }
  return out
}

/** Round to `digits` decimals (for compact JSON). */
export function round(x: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

/** Index of the first element >= t in a sorted array (binary search). */
export function lowerBound(sorted: ArrayLike<number>, t: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Distance from t to the nearest element of a sorted grid (Infinity for an empty grid). */
export function nearestDistance(sorted: ArrayLike<number>, t: number): number {
  const n = sorted.length
  if (n === 0) return Infinity
  const i = lowerBound(sorted, t)
  let d = Infinity
  if (i < n) d = Math.abs(sorted[i] - t)
  if (i > 0) d = Math.min(d, Math.abs(t - sorted[i - 1]))
  return d
}

/** Nearest element of a sorted, non-empty grid. */
export function nearestValue(sorted: ArrayLike<number>, t: number): number {
  const n = sorted.length
  const i = lowerBound(sorted, t)
  if (i <= 0) return sorted[0]
  if (i >= n) return sorted[n - 1]
  return t - sorted[i - 1] <= sorted[i] - t ? sorted[i - 1] : sorted[i]
}
