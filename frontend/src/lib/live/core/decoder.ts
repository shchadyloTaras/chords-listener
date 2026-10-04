// Online chord decoding for the sticky HMM of the offline engine (src/lib/engine/core/hmm.ts:
// staying is free, every switch costs `switchCost` (+ an optional per-frame penalty)):
//
//   * forward filtering: p(state_t | frames 0..t)            -> the current chord, at once
//   * fixed-lag smoothing: p(state_s | frames 0..t), s >= t-L -> frame t-L is committed as the
//     argmax of its smoothed posterior (MPM decoding with a fixed decision delay of L frames)
//   * minimum-duration cleanup on the committed path, like the offline absorbShort(): a run that
//     ends before lasting `minFrames` frames is given to the neighbour that explains it best.
//
// Runs move through three stages: provisional (inside the lag), confirmed (label fixed: its first
// frame is committed and it lasts at least `minFrames`) and final (label and both ends fixed:
// the run after it is confirmed, so it can no longer absorb anything).

export interface DecoderOptions {
  /** number of states */
  K: number
  /** smoothing lag in frames */
  lag: number
  /** log-cost of a state change (the offline `changePenalty`) */
  switchCost: number
  /** runs shorter than this (frames) are absorbed by a neighbour */
  minFrames: number
  /**
   * display hysteresis: uncommitted runs shorter than this many frames are shown as part of the
   * run before them (a new chord appears once it has won `hold` frames in a row). Default 1.
   */
  hold?: number
}

export interface DecodedRun {
  state: number
  /** first frame (inclusive) */
  first: number
  /** last frame (exclusive) */
  last: number
  /** mean posterior of `state` over the run's frames */
  confidence: number
  /** label fixed */
  confirmed: boolean
  /** label and boundaries fixed */
  final: boolean
}

interface Run {
  state: number
  first: number
  last: number
  /** per-state sum of the committed frames' smoothed posteriors */
  sums: Float64Array
  confirmed: boolean
  final: boolean
}

export class OnlineChordDecoder {
  readonly K: number
  readonly lag: number
  readonly switchCost: number
  private minFrames: number
  private readonly hold: number
  /** frames pushed */
  private t = 0
  /** frames committed (all frames < committed) */
  private committed = 0
  // ring buffers over the last lag + 1 frames
  private readonly W: number
  private readonly e: Float64Array
  private readonly alpha: Float64Array
  private readonly c: Float64Array
  // scratch
  private readonly beta: Float64Array
  private readonly post: Float64Array
  private readonly b: Float64Array
  private runs: Run[] = []
  private pendingFinal: Run[] = []
  /** argmax of the smoothed posterior of each uncommitted frame (oldest first) */
  private tail: { state: number; p: number }[] = []
  /** smoothed posteriors of the uncommitted frames (rows of K) */
  private tailPost: Float64Array
  private finished = false

  constructor(options: DecoderOptions) {
    this.K = options.K
    this.lag = Math.max(0, Math.floor(options.lag))
    this.switchCost = options.switchCost
    this.minFrames = Math.max(1, Math.round(options.minFrames))
    this.hold = Math.max(1, Math.floor(options.hold ?? 1))
    this.W = this.lag + 1
    this.e = new Float64Array(this.W * this.K)
    this.alpha = new Float64Array(this.W * this.K)
    this.c = new Float64Array(this.W)
    this.beta = new Float64Array(this.W * this.K)
    this.post = new Float64Array(this.W * this.K)
    this.b = new Float64Array(this.K)
    this.tailPost = new Float64Array(this.W * this.K)
  }

  /** Frames pushed so far. */
  get frames(): number {
    return this.t
  }

  /** Frames whose state is committed (decided with the full lag). */
  get committedFrames(): number {
    return this.committed
  }

  setMinFrames(n: number): void {
    this.minFrames = Math.max(1, Math.round(n))
  }

  /** Add one frame of log scores (length K); `penalty` adds to the switch cost into this frame. */
  push(scores: ArrayLike<number>, penalty = 0): void {
    if (this.finished) throw new Error('OnlineChordDecoder: push after finish')
    const { K, W } = this
    const slot = this.t % W
    const eo = slot * K
    let m = -Infinity
    for (let k = 0; k < K; k++) if (scores[k] > m) m = scores[k]
    if (!Number.isFinite(m)) m = 0
    for (let k = 0; k < K; k++) {
      const v = Math.exp(scores[k] - m)
      this.e[eo + k] = Number.isFinite(v) ? v : 0
    }
    // forward step (same recursion as posteriorsSticky)
    const c = this.t === 0 ? 0 : Math.exp(-(this.switchCost + penalty))
    this.c[slot] = c
    let sum = 0
    if (this.t === 0) {
      for (let k = 0; k < K; k++) {
        this.alpha[eo + k] = this.e[eo + k]
        sum += this.e[eo + k]
      }
    } else {
      const po = ((this.t - 1) % W) * K
      for (let k = 0; k < K; k++) {
        const v = this.e[eo + k] * Math.max(this.alpha[po + k] * (1 - c) + c, 1e-300)
        this.alpha[eo + k] = v
        sum += v
      }
    }
    if (sum > 0) for (let k = 0; k < K; k++) this.alpha[eo + k] /= sum
    else for (let k = 0; k < K; k++) this.alpha[eo + k] = 1 / K
    this.t++
    this.smooth(false)
  }

  /** Filtered posterior of the newest frame (a copy), or null before the first frame. */
  filtered(): Float64Array | null {
    if (this.t === 0) return null
    const o = ((this.t - 1) % this.W) * this.K
    return this.alpha.slice(o, o + this.K)
  }

  /** Runs that became final since the previous call (oldest first). */
  takeFinal(): DecodedRun[] {
    const out = this.pendingFinal.map((r) => this.view(r))
    this.pendingFinal = []
    return out
  }

  /**
   * Everything after the final runs, oldest first: the last closed run (until the run after it
   * is confirmed), the open committed run, then the uncommitted frames grouped into runs.
   * The last element is the current chord.
   */
  open(): DecodedRun[] {
    const out: DecodedRun[] = []
    for (const r of this.runs) if (!r.final) out.push(this.view(r))
    let i = 0
    const n = this.tail.length
    while (i < n) {
      let state = this.tail[i].state
      let j = i
      let p = 0
      while (j < n && this.tail[j].state === state) p += this.tail[j++].p
      const first = this.committed + i
      const last = this.committed + j
      let prev = out[out.length - 1]
      if (prev && j - i < this.hold && prev.state !== state) {
        // too new to show: the run before it continues (its own posterior counts as confidence)
        state = prev.state
        p = 0
        for (let f = i; f < j; f++) p += this.tailPost[f * this.K + state]
      }
      prev = out[out.length - 1]
      if (prev && prev.state === state && prev.last === first) {
        const len0 = prev.last - prev.first
        prev.confidence = (prev.confidence * len0 + p) / (len0 + (j - i))
        prev.last = last
      } else {
        out.push({ state, first, last, confidence: p / (j - i), confirmed: false, final: false })
      }
      i = j
    }
    return out
  }

  /** End of input: commit every frame with full smoothing and close the last run. Returns all remaining runs (final). */
  finish(): DecodedRun[] {
    if (!this.finished) {
      this.finished = true
      this.smooth(true)
      const lastRun = this.runs[this.runs.length - 1]
      if (lastRun) this.close(lastRun, -1)
      for (const r of this.runs) this.finalize(r)
    }
    return this.takeFinal()
  }

  private view(r: Run): DecodedRun {
    const n = Math.max(1, r.last - r.first)
    return { state: r.state, first: r.first, last: r.last, confidence: r.sums[r.state] / n, confirmed: r.confirmed, final: r.final }
  }

  /**
   * Backward pass over the window [t - 1 - lag, t - 1] (or all of it when flushing), then commit
   * frames that have their full lag (all of them when flushing) and keep the rest as the tail.
   */
  private smooth(flush: boolean): void {
    const { K, W } = this
    const newest = this.t - 1
    if (newest < 0) return
    const lo = Math.max(this.committed, newest - this.lag)
    const span = newest - lo + 1
    const beta = this.beta
    const post = this.post
    // beta of the newest frame = 1
    for (let k = 0; k < K; k++) beta[(span - 1) * K + k] = 1
    for (let i = span - 2; i >= 0; i--) {
      const s1 = lo + i + 1
      const eo = (s1 % W) * K
      const c = this.c[s1 % W]
      let S = 0
      for (let k = 0; k < K; k++) {
        const v = this.e[eo + k] * beta[(i + 1) * K + k]
        this.b[k] = v
        S += v
      }
      let top = 0
      for (let k = 0; k < K; k++) {
        const v = this.b[k] * (1 - c) + c * S
        beta[i * K + k] = v
        if (v > top) top = v
      }
      if (top > 0) for (let k = 0; k < K; k++) beta[i * K + k] /= top
    }
    for (let i = 0; i < span; i++) {
      const ao = ((lo + i) % W) * K
      let s = 0
      for (let k = 0; k < K; k++) {
        const v = this.alpha[ao + k] * beta[i * K + k]
        post[i * K + k] = v
        s += v
      }
      if (s > 0) for (let k = 0; k < K; k++) post[i * K + k] /= s
      else for (let k = 0; k < K; k++) post[i * K + k] = 1 / K
    }
    // commit frames whose lag has passed
    const commitTo = flush ? newest + 1 : Math.max(this.committed, newest - this.lag + 1)
    for (let f = this.committed; f < commitTo; f++) this.commit(f, post.subarray((f - lo) * K, (f - lo + 1) * K))
    this.committed = commitTo
    // provisional tail
    this.tail = []
    for (let f = commitTo; f <= newest; f++) {
      const row = post.subarray((f - lo) * K, (f - lo + 1) * K)
      this.tailPost.set(row, (f - commitTo) * K)
      let arg = 0
      for (let k = 1; k < K; k++) if (row[k] > row[arg]) arg = k
      this.tail.push({ state: arg, p: row[arg] })
    }
    this.updateConfirmation()
  }

  private commit(f: number, p: Float64Array): void {
    let s = 0
    for (let k = 1; k < this.K; k++) if (p[k] > p[s]) s = k
    const open = this.runs[this.runs.length - 1]
    if (open && open.state === s) {
      open.last = f + 1
      for (let k = 0; k < this.K; k++) open.sums[k] += p[k]
      return
    }
    const run: Run = { state: s, first: f, last: f + 1, sums: Float64Array.from(p), confirmed: false, final: false }
    if (open) {
      const absorbed = this.close(open, s)
      if (absorbed === 'next') {
        // the short run's frames go to the new run
        run.first = open.first
        for (let k = 0; k < this.K; k++) run.sums[k] += open.sums[k]
      }
      const prev = this.runs[this.runs.length - 1]
      if (prev && prev.state === s && prev.last === run.first) {
        // e.g. C, short G, C: the blip went back to C, which simply continues
        prev.last = run.last
        for (let k = 0; k < this.K; k++) prev.sums[k] += run.sums[k]
        return
      }
    }
    this.runs.push(run)
  }

  /**
   * Close `run` (the open run) because frame `run.last` starts `nextState` (-1 at the end).
   * A short, unconfirmed run is absorbed by the neighbour with the higher posterior mass over
   * its frames: the previous run (extended) or the next one (returns 'next'; the caller
   * prepends the frames).
   */
  private close(run: Run, nextState: number): 'kept' | 'prev' | 'next' {
    const idx = this.runs.length - 1
    const prev = idx > 0 ? this.runs[idx - 1] : null
    const len = run.last - run.first
    if (!run.confirmed && len < this.minFrames && (prev || nextState >= 0)) {
      const sPrev = prev ? run.sums[prev.state] : -Infinity
      const sNext = nextState >= 0 ? run.sums[nextState] : -Infinity
      this.runs.pop()
      if (prev && sPrev >= sNext) {
        prev.last = run.last
        for (let k = 0; k < this.K; k++) prev.sums[k] += run.sums[k]
        return 'prev'
      }
      return 'next'
    }
    // kept: the run before it can no longer change
    if (prev) this.finalize(prev)
    return 'kept'
  }

  private finalize(run: Run): void {
    if (run.final) return
    run.final = true
    run.confirmed = true
    this.pendingFinal.push(run)
  }

  /** Confirm the open run once its first frame is committed and it (with the tail) lasts minFrames. */
  private updateConfirmation(): void {
    const open = this.runs[this.runs.length - 1]
    if (!open || open.confirmed) return
    let len = open.last - open.first
    for (const f of this.tail) {
      if (f.state !== open.state) break
      len++
    }
    if (len >= this.minFrames) {
      open.confirmed = true
      const prev = this.runs[this.runs.length - 2]
      if (prev) this.finalize(prev)
    }
  }
}
