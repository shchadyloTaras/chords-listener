// Tap tempo: the median interval of the most recent taps. A pause longer than `resetAfter`
// starts a new series, so a fresh round of tapping never mixes with an old one.

export interface TapTempoOptions {
  /** ms of silence after which the next tap starts a new series (default 2000) */
  resetAfter?: number
  /** how many recent taps are used (default 8 → 7 intervals) */
  maxTaps?: number
}

export interface TapReading {
  /** null until there are two taps */
  bpm: number | null
  /** taps in the current series */
  count: number
}

/** Taps closer than this are contact bounce / double events and are ignored. */
const DEBOUNCE_MS = 60
const MIN_BPM = 20
const MAX_BPM = 400

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export class TapTempo {
  private taps: number[] = []
  private readonly resetAfter: number
  private readonly maxTaps: number

  constructor(opts: TapTempoOptions = {}) {
    this.resetAfter = opts.resetAfter ?? 2000
    this.maxTaps = Math.max(2, opts.maxTaps ?? 8)
  }

  /** Registers a tap at `now` (ms, e.g. performance.now()) and returns the current estimate. */
  tap(now: number): TapReading {
    const last = this.taps[this.taps.length - 1]
    if (last !== undefined && now - last < DEBOUNCE_MS && now >= last) return this.reading()
    if (last === undefined || now < last || now - last > this.resetAfter) this.taps = []
    this.taps.push(now)
    if (this.taps.length > this.maxTaps) this.taps.splice(0, this.taps.length - this.maxTaps)
    return this.reading()
  }

  /** True when the series has expired at `now` (the next tap starts over). */
  expired(now: number): boolean {
    const last = this.taps[this.taps.length - 1]
    return last === undefined || now - last > this.resetAfter
  }

  reset(): void {
    this.taps = []
  }

  reading(): TapReading {
    const n = this.taps.length
    if (n < 2) return { bpm: null, count: n }
    const ibis = this.taps.slice(1).map((t, i) => t - this.taps[i])
    const bpm = 60000 / median(ibis)
    return { bpm: bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null, count: n }
  }
}

export type TapRelation = 'match' | 'double' | 'half' | 'other'

/**
 * How a tapped tempo relates to a reference tempo: the same (±tol), about twice as fast,
 * about half as fast, or something else.
 */
export function tapRelation(tapped: number, reference: number, tol = 0.08): TapRelation {
  if (!(tapped > 0) || !(reference > 0)) return 'other'
  const r = tapped / reference
  if (Math.abs(r - 1) <= tol) return 'match'
  if (Math.abs(r / 2 - 1) <= tol) return 'double'
  if (Math.abs(r * 2 - 1) <= tol) return 'half'
  return 'other'
}
