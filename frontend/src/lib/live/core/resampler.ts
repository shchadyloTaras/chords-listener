// Streaming band-limited resampler. Same windowed-sinc kernel, phase table and arithmetic as the
// engine's offline `resample()` (src/lib/engine/core/resample.ts), so feeding a signal in chunks
// gives the same samples as resampling it whole (checked in resampler.test.ts).

const PHASES = 256

function blackman(x: number): number {
  const a = Math.PI * (x + 1)
  return 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-12) return 1
  const a = Math.PI * x
  return Math.sin(a) / a
}

export class StreamingResampler {
  readonly srIn: number
  readonly srOut: number
  private readonly passthrough: boolean
  private readonly step: number
  private readonly half: number
  private readonly taps: number
  private readonly table: Float32Array
  /** input history; `hist[0]` is input sample `histStart` */
  private hist: Float32Array
  private histStart = 0
  private histLen = 0
  /** total input samples received */
  private received = 0
  /** index of the next output sample */
  private produced = 0

  constructor(srIn: number, srOut: number) {
    if (!(srIn > 0) || !(srOut > 0)) throw new RangeError('sample rates must be positive')
    this.srIn = srIn
    this.srOut = srOut
    this.passthrough = srIn === srOut
    const ratio = srOut / srIn
    this.step = srIn / srOut
    const fc = 0.5 * Math.min(1, ratio) * 0.94
    this.half = Math.ceil(12 / Math.min(1, ratio))
    this.taps = 2 * this.half
    const taps = this.taps
    this.table = new Float32Array((PHASES + 1) * taps)
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES
      let sum = 0
      for (let j = 0; j < taps; j++) {
        const tau = frac - (j - this.half + 1)
        const v = 2 * fc * sinc(2 * fc * tau) * blackman(tau / (this.half + 1))
        this.table[p * taps + j] = v
        sum += v
      }
      for (let j = 0; j < taps; j++) this.table[p * taps + j] /= sum
    }
    this.hist = new Float32Array(Math.max(4096, 4 * taps))
  }

  /** Output samples produced so far. */
  get outputCount(): number {
    return this.produced
  }

  /** Feed input samples; returns the output samples that became computable (may be empty). */
  push(x: Float32Array): Float32Array {
    if (this.passthrough) {
      this.received += x.length
      this.produced += x.length
      return x.slice()
    }
    this.append(x)
    return this.drain(false)
  }

  /**
   * End of input: returns the remaining output, zero-padding past the end exactly like the
   * offline resampler (total output = round(inputLength * ratio), at least 1).
   */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0)
    return this.drain(true)
  }

  private append(x: Float32Array): void {
    const need = this.histLen + x.length
    if (need > this.hist.length) {
      // drop history no output can need any more, then grow if still short
      this.compact()
      if (this.histLen + x.length > this.hist.length) {
        const next = new Float32Array(Math.max(this.hist.length * 2, this.histLen + x.length))
        next.set(this.hist.subarray(0, this.histLen))
        this.hist = next
      }
    }
    this.hist.set(x, this.histLen)
    this.histLen += x.length
    this.received += x.length
  }

  /** First input index the next output sample reads. */
  private firstNeeded(): number {
    const t = this.produced * this.step
    return Math.floor(t) - this.half + 1
  }

  private compact(): void {
    const keepFrom = Math.max(this.histStart, this.firstNeeded() - 1)
    const drop = Math.min(this.histLen, keepFrom - this.histStart)
    if (drop <= 0) return
    this.hist.copyWithin(0, drop, this.histLen)
    this.histLen -= drop
    this.histStart += drop
  }

  private drain(final: boolean): Float32Array {
    const { taps, half, table, step } = this
    const total = final ? Math.max(1, Math.round(this.received * (this.srOut / this.srIn))) : Infinity
    const out: number[] = []
    const n = this.received
    for (;;) {
      if (this.produced >= total) break
      const i = this.produced
      const t = i * step
      let i0 = Math.floor(t)
      let p = Math.round((t - i0) * PHASES)
      if (p === PHASES) {
        p = 0
        i0 += 1
      }
      const first = i0 - half + 1
      // all inputs this output reads must have arrived (or lie past the end when flushing)
      if (!final && first + taps > n) break
      const base = p * taps
      let acc = 0
      const h0 = first - this.histStart
      if (first >= 0 && first + taps <= n && h0 >= 0) {
        for (let j = 0; j < taps; j++) acc += this.hist[h0 + j] * table[base + j]
      } else {
        for (let j = 0; j < taps; j++) {
          const k = first + j
          if (k >= 0 && k < n) acc += this.hist[k - this.histStart] * table[base + j]
        }
      }
      out.push(acc)
      this.produced++
    }
    return Float32Array.from(out)
  }
}
