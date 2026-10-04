// Rhythm: onset envelope -> tempo (windowed autocorrelation with a log-normal prior) ->
// dynamic-programming beat tracking (Ellis 2007) -> meter / downbeat phase from chord changes.

import { FFT, RealFFT, hann, nextPow2 } from './fft.ts'
import { SR } from './spectrum.ts'
import { median, nearestDistance, std } from './util.ts'

export const ONSET_N = 2048
export const ONSET_HOP = 512
export const ONSET_FPS = SR / ONSET_HOP
const N_MELS = 64
const TOP_DB = 80
/** frames the envelope is delayed by to counter the centered-window framing */
const ONSET_DELAY = 0
/** calibrated on synthetic songs: flux peaks ~half a frame before the audible onset */
const BEAT_OFFSET_FRAMES = 0.5

export const TEMPO_PRIOR_BPM = 110
export const TEMPO_PRIOR_OCTAVES = 1.0

export interface Rhythm {
  beats: number[]
  downbeats: number[]
  timeSignature: number
  tempo: number
}

function hzToMel(f: number): number {
  return 2595 * Math.log10(1 + f / 700)
}

function melToHz(m: number): number {
  return 700 * (10 ** (m / 2595) - 1)
}

/** Sparse triangular mel filterbank over the bins of an `nfft`-point spectrum. */
function melFilterbank(nfft: number, nMels: number, fmin: number, fmax: number) {
  const nBins = nfft / 2 + 1
  const mLo = hzToMel(fmin)
  const mHi = hzToMel(fmax)
  const edges = Array.from({ length: nMels + 2 }, (_, i) => melToHz(mLo + ((mHi - mLo) * i) / (nMels + 1)))
  const df = SR / nfft
  const start = new Int32Array(nMels)
  const count = new Int32Array(nMels)
  const idx: number[] = []
  const w: number[] = []
  for (let m = 0; m < nMels; m++) {
    const [a, c, b] = [edges[m], edges[m + 1], edges[m + 2]]
    start[m] = idx.length
    for (let k = Math.max(0, Math.floor(a / df)); k < nBins && k * df <= b; k++) {
      const f = k * df
      const v = f <= c ? (f - a) / Math.max(c - a, 1e-9) : (b - f) / Math.max(b - c, 1e-9)
      if (v > 0) {
        idx.push(k)
        w.push(v)
      }
    }
    // narrow low bands may fall between bins: use the nearest bin
    if (idx.length === start[m]) {
      idx.push(Math.min(nBins - 1, Math.round(c / df)))
      w.push(1)
    }
    count[m] = idx.length - start[m]
  }
  return { start, count, idx: Int32Array.from(idx), w: Float32Array.from(w) }
}

/**
 * Spectral-flux onset strength at ONSET_FPS (~43 Hz) from 22.05 kHz mono audio:
 * log-mel power, half-wave rectified first difference, aggregated over bands. The mean
 * (default) also follows tonal onsets (piano, strummed guitar), which keeps the tempo
 * estimate on the beat level; the median only counts broadband (drum) events.
 */
export function onsetEnvelope(y: Float32Array, aggregate: 'median' | 'mean' = 'mean'): Float32Array {
  const T = 1 + Math.floor(y.length / ONSET_HOP)
  const fft = new RealFFT(ONSET_N)
  const win = hann(ONSET_N)
  const buf = new Float64Array(ONSET_N)
  const P = new Float64Array(ONSET_N / 2 + 1)
  const fb = melFilterbank(ONSET_N, N_MELS, 30, 8000)
  const mel = new Float32Array(T * N_MELS)
  let top = -Infinity
  const half = ONSET_N >> 1
  for (let t = 0; t < T; t++) {
    const s0 = t * ONSET_HOP - half
    for (let i = 0; i < ONSET_N; i++) {
      const k = s0 + i
      buf[i] = k >= 0 && k < y.length ? y[k] * win[i] : 0
    }
    fft.power(buf, P)
    for (let m = 0; m < N_MELS; m++) {
      let s = 0
      const a = fb.start[m]
      const b = a + fb.count[m]
      for (let i = a; i < b; i++) s += fb.w[i] * P[fb.idx[i]]
      const db = 10 * Math.log10(Math.max(s, 1e-10))
      mel[t * N_MELS + m] = db
      if (db > top) top = db
    }
  }
  const floor = top - TOP_DB
  for (let i = 0; i < mel.length; i++) if (mel[i] < floor) mel[i] = floor
  const env = new Float32Array(T)
  const diff = new Float64Array(N_MELS)
  for (let t = 1; t < T; t++) {
    let sum = 0
    for (let m = 0; m < N_MELS; m++) {
      const d = mel[t * N_MELS + m] - mel[(t - 1) * N_MELS + m]
      diff[m] = d > 0 ? d : 0
      sum += diff[m]
    }
    const v = aggregate === 'mean' ? sum / N_MELS : median(diff)
    const tt = t + ONSET_DELAY
    if (tt < T) env[tt] = v
  }
  return env
}

/**
 * Global tempo (BPM): mean of windowed (8 s), normalized autocorrelations of the onset
 * envelope, weighted by a log-normal prior around TEMPO_PRIOR_BPM.
 */
export function estimateTempo(env: Float32Array, fps = ONSET_FPS, priorBpm = TEMPO_PRIOR_BPM,
  priorOctaves = TEMPO_PRIOR_OCTAVES): number {
  const T = env.length
  // smooth first: sharp onsets at non-integer periods would otherwise favour lags that
  // happen to be near-integer multiples of the period (half tempo)
  const sm = new Float32Array(T)
  for (let t = 0; t < T; t++) {
    let s = 0
    let norm = 0
    for (let k = -3; k <= 3; k++) {
      const i = t + k
      if (i < 0 || i >= T) continue
      const g = Math.exp(-0.5 * (k / 1.2) ** 2)
      s += g * env[i]
      norm += g
    }
    sm[t] = s / norm
  }
  const win = Math.min(Math.round(8 * fps), Math.max(16, T))
  const nfft = nextPow2(2 * win)
  const fft = new FFT(nfft)
  const re = new Float64Array(nfft)
  const im = new Float64Array(nfft)
  const w = hann(win)
  const acc = new Float64Array(win)
  const half = win >> 1
  const step = 4
  let frames = 0
  for (let c = 0; c < T; c += step) {
    re.fill(0)
    im.fill(0)
    let energy = 0
    for (let i = 0; i < win; i++) {
      const k = c - half + i
      const v = k >= 0 && k < T ? sm[k] * w[i] : 0
      re[i] = v
      energy += v * v
    }
    if (energy <= 1e-12) continue
    fft.transform(re, im)
    for (let i = 0; i < nfft; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i]
      im[i] = 0
    }
    fft.inverse(re, im)
    const r0 = re[0]
    if (r0 <= 1e-12) continue
    for (let lag = 0; lag < win; lag++) acc[lag] += re[lag] / r0
    frames++
  }
  if (frames === 0) return 0
  let bestLag = -1
  let bestScore = -Infinity
  const lp = Math.log2(priorBpm)
  for (let lag = 1; lag < win; lag++) {
    const bpm = (60 * fps) / lag
    if (bpm > 320 || bpm < 30) continue
    const tg = Math.max(acc[lag] / frames, 0)
    const score = Math.log1p(1e6 * tg) - 0.5 * ((Math.log2(bpm) - lp) / priorOctaves) ** 2
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestLag < 0) return 0
  // parabolic refinement of the autocorrelation peak
  let lag = bestLag
  if (bestLag > 1 && bestLag < win - 1) {
    const a = acc[bestLag - 1]
    const b = acc[bestLag]
    const c = acc[bestLag + 1]
    const den = a - 2 * b + c
    if (den < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
  }
  return (60 * fps) / lag
}

/**
 * Beat times (seconds) by dynamic programming: maximize onset strength at beats while
 * keeping inter-beat intervals close to the tempo period.
 */
export function trackBeats(env: Float32Array, bpm: number, fps = ONSET_FPS, tightness = 100): number[] {
  const T = env.length
  if (T < 8 || !(bpm > 0)) return []
  const sd = std(env)
  if (!(sd > 1e-9)) return []
  const period = (60 * fps) / bpm
  // local score: onset envelope smoothed with a Gaussian of width ~period/32
  const r = Math.max(1, Math.round(period))
  const kern = new Float64Array(2 * r + 1)
  for (let k = -r; k <= r; k++) kern[k + r] = Math.exp(-0.5 * ((k * 32) / period) ** 2)
  const local = new Float64Array(T)
  let maxLocal = 0
  for (let t = 0; t < T; t++) {
    let s = 0
    for (let k = -r; k <= r; k++) {
      const i = t + k
      if (i >= 0 && i < T) s += env[i] * kern[k + r]
    }
    local[t] = s / sd
    if (local[t] > maxLocal) maxLocal = local[t]
  }
  const w0 = -Math.round(2 * period)
  const w1 = -Math.round(period / 2)
  const nW = w1 - w0 + 1
  const txwt = new Float64Array(nW)
  for (let i = 0; i < nW; i++) txwt[i] = -tightness * Math.log(-(w0 + i) / period) ** 2
  const cum = new Float64Array(T)
  const back = new Int32Array(T)
  let first = true
  for (let t = 0; t < T; t++) {
    let best = -Infinity
    let bestPrev = -1
    for (let i = 0; i < nW; i++) {
      const p = t + w0 + i
      const v = p >= 0 ? txwt[i] + cum[p] : txwt[i]
      if (v > best) {
        best = v
        bestPrev = p >= 0 ? p : -1
      }
    }
    cum[t] = local[t] + best
    if (first && local[t] < 0.01 * maxLocal) {
      back[t] = -1
    } else {
      back[t] = bestPrev
      first = false
    }
  }
  // last beat: the latest local maximum of the cumulative score above half its median
  const maxima: number[] = []
  for (let t = 1; t < T; t++) {
    if (cum[t] > cum[t - 1] && (t === T - 1 || cum[t] >= cum[t + 1])) maxima.push(t)
  }
  if (maxima.length === 0) return []
  const med = median(maxima.map((t) => cum[t]))
  let last = -1
  for (const t of maxima) if (2 * cum[t] > med) last = t
  if (last < 0) return []
  const beats: number[] = []
  for (let b = last; b >= 0; b = back[b]) {
    beats.push(b)
    if (back[b] >= b) break
  }
  beats.reverse()
  // sub-frame beat positions: parabolic peak of the local score around each beat frame
  const toTime = (f: number): number => {
    let pos = f
    if (f > 0 && f < T - 1) {
      const a = local[f - 1]
      const b = local[f]
      const c = local[f + 1]
      const den = a - 2 * b + c
      if (den < 0 && b >= a && b >= c) pos += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
    }
    return (pos + BEAT_OFFSET_FRAMES) / fps
  }
  // trim weak beats at both ends (silence / fade)
  const n = beats.length
  if (n < 3) return beats.map(toTime)
  const smooth = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    smooth[i] = local[beats[i]] + 0.5 * ((i > 0 ? local[beats[i - 1]] : 0) + (i + 1 < n ? local[beats[i + 1]] : 0))
  }
  let ms = 0
  for (let i = 0; i < n; i++) ms += smooth[i] ** 2
  const thr = 0.5 * Math.sqrt(ms / n)
  let a = 0
  let b = n - 1
  while (a < n && smooth[a] <= thr) a++
  while (b > a && smooth[b] <= thr) b--
  return beats.slice(a, b + 1).map(toTime)
}

/** BPM from beat times: mean inter-beat interval of the intervals within 20 % of the median. */
export function tempoFromBeats(beats: readonly number[]): number {
  const ibi: number[] = []
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1]
    if (d > 0.2 && d < 2) ibi.push(d)
  }
  if (!ibi.length) return 0
  const med = median(ibi)
  const near = ibi.filter((d) => Math.abs(d / med - 1) < 0.2)
  return 60 / (near.reduce((s, d) => s + d, 0) / near.length)
}

/** Pick the time signature (4 or 3) and bar phase so that chord changes fall on downbeats. */
export function chooseMeter(beats: readonly number[], changeTimes: readonly number[],
  changeWeights?: readonly number[]): { downbeats: number[]; meter: number } {
  if (beats.length < 4) return { downbeats: beats.slice(0, 1), meter: 4 }
  const ibis: number[] = []
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1])
  const ibi = median(ibis)
  const w = changeWeights ?? changeTimes.map(() => 1)
  const wsum = w.reduce((s, v) => s + v, 0)
  const scoreOf = (meter: number, phase: number): number => {
    if (changeTimes.length === 0) return phase === 0 ? 1 : 0
    const downs = beats.filter((_, i) => i >= phase && (i - phase) % meter === 0)
    let hit = 0
    changeTimes.forEach((c, i) => {
      if (nearestDistance(downs, c) < 0.3 * ibi) hit += w[i]
    })
    return hit / Math.max(wsum, 1e-9)
  }
  let best4 = { score: -1, phase: 0 }
  for (let p = 0; p < 4; p++) {
    const s = scoreOf(4, p)
    if (s > best4.score) best4 = { score: s, phase: p }
  }
  let best3 = { score: -1, phase: 0 }
  for (let p = 0; p < 3; p++) {
    const s = scoreOf(3, p)
    if (s > best3.score) best3 = { score: s, phase: p }
  }
  // 3/4 only when changes clearly follow a 3-beat grid (and not also the 4-grid)
  const use3 = best3.score > best4.score + 0.2 && best3.score > 0.6
  const meter = use3 ? 3 : 4
  const phase = use3 ? best3.phase : best4.phase
  return { downbeats: beats.filter((_, i) => i >= phase && (i - phase) % meter === 0), meter }
}
