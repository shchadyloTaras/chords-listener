// Harmonic features: tuning estimate, multi-resolution log-frequency spectrum (1/3 semitone,
// A0..G#7), percussive suppression, NNLS-style note decomposition -> treble + bass chroma.

import { RealFFT, hann } from './fft.ts'
import { medianFilterTime } from './util.ts'

export const SR = 22050
export const HOP = 2048 // ~10.8 frames per second
export const FPS = SR / HOP
export const BINS_PER_SEMITONE = 3
export const FMIN_MIDI = 21 // A0
export const N_SEMITONES = 84 // A0 .. G#7
export const N_LOG_BINS = N_SEMITONES * BINS_PER_SEMITONE
const N_PARTIALS = 8
const PARTIAL_DECAY = 0.7
const NNLS_ITERATIONS = 40

/** STFT resolutions: long windows resolve the bass, shorter ones keep chord changes sharp. */
const BANDS: readonly { size: number; maxMidi: number }[] = [
  { size: 16384, maxMidi: 52 }, // A0 .. D#3
  { size: 8192, maxMidi: Infinity }, // E3 .. G#7
]

export interface ChromaFeatures {
  /** number of frames; frame t is centered at t * HOP / SR seconds */
  T: number
  fps: number
  /** (T x 12) chroma of the harmonic content (treble register) */
  treble: Float32Array
  /** (T x 12) bass-register chroma */
  bass: Float32Array
  /** tuning offset from A440 in semitones, [-0.5, 0.5) */
  tuning: number
}

export type FractionFn = (fraction: number) => void

export function frameCount(nSamples: number): number {
  return 1 + Math.floor(nSamples / HOP)
}

function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12)
}

/** Fill `buf` with the Hann-windowed frame of `y` centered at sample `center` (zero-padded). */
function windowFrame(y: Float32Array, center: number, win: Float64Array, buf: Float64Array): void {
  const n = win.length
  const start = center - (n >> 1)
  if (start >= 0 && start + n <= y.length) {
    for (let i = 0; i < n; i++) buf[i] = y[start + i] * win[i]
    return
  }
  for (let i = 0; i < n; i++) {
    const k = start + i
    buf[i] = k >= 0 && k < y.length ? y[k] * win[i] : 0
  }
}

/**
 * Deviation from A440 equal temperament in semitones, in [-0.5, 0.5): weighted histogram
 * of the fractional pitch of strong spectral peaks over (up to) 160 frames.
 */
export function estimateTuning(y: Float32Array): number {
  const n = 8192
  if (y.length < SR / 2) return 0
  const fft = new RealFFT(n)
  const win = hann(n)
  const buf = new Float64Array(n)
  const P = new Float64Array(n / 2 + 1)
  const nHist = 100
  const hist = new Float64Array(nHist)
  const frames = Math.min(160, Math.max(1, Math.floor(y.length / HOP)))
  const kLo = Math.ceil((80 * n) / SR)
  const kHi = Math.floor((2000 * n) / SR)
  let peaks = 0
  for (let f = 0; f < frames; f++) {
    const center = Math.floor(((f + 0.5) / frames) * y.length)
    windowFrame(y, center, win, buf)
    fft.power(buf, P)
    let top = 0
    for (let k = kLo; k <= kHi; k++) if (P[k] > top) top = P[k]
    if (top <= 1e-12) continue
    const thr = top * 0.01 // -20 dB
    for (let k = kLo; k <= kHi; k++) {
      const v = P[k]
      if (v < thr || v <= P[k - 1] || v < P[k + 1]) continue
      // parabolic interpolation on log power
      const a = Math.log(P[k - 1] + 1e-20)
      const b = Math.log(v + 1e-20)
      const c = Math.log(P[k + 1] + 1e-20)
      const den = a - 2 * b + c
      const delta = den < 0 ? (0.5 * (a - c)) / den : 0
      const freq = ((k + Math.max(-0.5, Math.min(0.5, delta))) * SR) / n
      const midi = 69 + 12 * Math.log2(freq / 440)
      let dev = midi - Math.round(midi) // [-0.5, 0.5]
      if (dev >= 0.5) dev -= 1
      const bin = Math.min(nHist - 1, Math.floor((dev + 0.5) * nHist))
      hist[bin] += Math.sqrt(v)
      peaks++
    }
  }
  if (peaks < 20) return 0
  // circular smoothing (+-3 bins), then the mode
  let best = 0
  let bestVal = -1
  for (let i = 0; i < nHist; i++) {
    let s = 0
    for (let d = -3; d <= 3; d++) s += hist[(i + d + nHist) % nHist] * (4 - Math.abs(d))
    if (s > bestVal) {
      bestVal = s
      best = i
    }
  }
  const t = (best + 0.5) / nHist - 0.5
  return Math.max(-0.5, Math.min(0.4999, t))
}

interface BandKernel {
  fft: RealFFT
  win: Float64Array
  buf: Float64Array
  power: Float64Array
  /** log bins handled by this band */
  bins: number[]
  /** per log bin: offset into idx/w and count */
  start: Int32Array
  count: Int32Array
  idx: Int32Array
  w: Float32Array
  /** amplitude normalization: a full-scale sinusoid -> ~1 */
  scale: number
}

function buildBand(size: number, bins: number[], freqs: Float64Array): BandKernel {
  const df = SR / size
  const ratio = 2 ** (1 / 36) - 1
  const start = new Int32Array(N_LOG_BINS)
  const count = new Int32Array(N_LOG_BINS)
  const idx: number[] = []
  const w: number[] = []
  for (const b of bins) {
    const f = freqs[b]
    const half = Math.max(df, f * ratio) // triangle half-width in Hz
    const jLo = Math.max(1, Math.ceil((f - half) / df))
    const jHi = Math.min(size / 2 - 1, Math.floor((f + half) / df))
    start[b] = idx.length
    for (let j = jLo; j <= jHi; j++) {
      const wt = 1 - Math.abs(j * df - f) / half
      if (wt <= 0) continue
      idx.push(j)
      w.push(wt)
    }
    count[b] = idx.length - start[b]
  }
  const win = hann(size)
  let wsum = 0
  for (let i = 0; i < size; i++) wsum += win[i]
  return {
    fft: new RealFFT(size),
    win,
    buf: new Float64Array(size),
    power: new Float64Array(size / 2 + 1),
    bins,
    start,
    count,
    idx: Int32Array.from(idx),
    w: Float32Array.from(w),
    scale: 2 / wsum,
  }
}

/** Log-frequency magnitude spectrogram (T x N_LOG_BINS), bins centered on the tuned semitones. */
export function logFrequencySpectrogram(y: Float32Array, tuning: number, onFraction?: FractionFn): Float32Array {
  const T = frameCount(y.length)
  const freqs = new Float64Array(N_LOG_BINS)
  for (let b = 0; b < N_LOG_BINS; b++) {
    freqs[b] = midiToHz(FMIN_MIDI + tuning + (b - 1) / BINS_PER_SEMITONE)
  }
  const bands: BandKernel[] = []
  let lo = 0
  for (const band of BANDS) {
    const bins: number[] = []
    for (let b = lo; b < N_LOG_BINS; b++) {
      if (FMIN_MIDI + Math.floor(b / BINS_PER_SEMITONE) >= band.maxMidi) break
      bins.push(b)
    }
    if (bins.length) bands.push(buildBand(band.size, bins, freqs))
    lo += bins.length
  }
  const C = new Float32Array(T * N_LOG_BINS)
  const report = Math.max(1, Math.floor(T / 50))
  for (let t = 0; t < T; t++) {
    const center = t * HOP
    for (const k of bands) {
      windowFrame(y, center, k.win, k.buf)
      k.fft.power(k.buf, k.power)
      const P = k.power
      for (const b of k.bins) {
        let s = 0
        const s0 = k.start[b]
        const s1 = s0 + k.count[b]
        for (let i = s0; i < s1; i++) s += k.w[i] * P[k.idx[i]]
        C[t * N_LOG_BINS + b] = Math.sqrt(s) * k.scale
      }
    }
    if (onFraction && t % report === 0) onFraction(t / T)
  }
  return C
}

// ---------------------------------------------------------------------------------------
// note decomposition

interface NoteDictionary {
  /** (N_SEMITONES bins x N_SEMITONES notes), row-major, column-normalized */
  W: Float64Array
  /** sparse W^T W in CSR form */
  rowPtr: Int32Array
  colIdx: Int32Array
  vals: Float64Array
}

let dictionary: NoteDictionary | null = null

function noteDictionary(): NoteDictionary {
  if (dictionary) return dictionary
  const N = N_SEMITONES
  const W = new Float64Array(N * N)
  for (let n = 0; n < N; n++) {
    for (let k = 1; k <= N_PARTIALS; k++) {
      const b = n + 12 * Math.log2(k)
      const lo = Math.floor(b)
      const frac = b - lo
      const amp = PARTIAL_DECAY ** (k - 1)
      if (lo < N) W[lo * N + n] += amp * (1 - frac)
      if (frac > 0 && lo + 1 < N) W[(lo + 1) * N + n] += amp * frac
    }
  }
  for (let n = 0; n < N; n++) {
    let norm = 0
    for (let s = 0; s < N; s++) norm += W[s * N + n] ** 2
    norm = Math.sqrt(norm) || 1
    for (let s = 0; s < N; s++) W[s * N + n] /= norm
  }
  const rowPtr = new Int32Array(N + 1)
  const cols: number[] = []
  const vals: number[] = []
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let v = 0
      for (let s = 0; s < N; s++) v += W[s * N + i] * W[s * N + j]
      if (v > 1e-12) {
        cols.push(j)
        vals.push(v)
      }
    }
    rowPtr[i + 1] = cols.length
  }
  dictionary = { W, rowPtr, colIdx: Int32Array.from(cols), vals: Float64Array.from(vals) }
  return dictionary
}

function trebleBassProfiles(): { treble: Float64Array; bass: Float64Array } {
  const treble = new Float64Array(N_SEMITONES)
  const bass = new Float64Array(N_SEMITONES)
  for (let n = 0; n < N_SEMITONES; n++) {
    const m = FMIN_MIDI + n
    treble[n] = Math.min(1, Math.max(0, (m - 44) / 8)) * Math.min(1, Math.max(0, (100 - m) / 12))
    bass[n] = m >= 26 && m <= 57 ? Math.exp(-0.5 * ((m - 40) / 6) ** 2) : 0
  }
  return { treble, bass }
}

/**
 * Note activations from the log-frequency spectrogram, folded into treble and bass chroma.
 * Mirrors the backend's DSP features: median filter in time, max over sub-bins, sqrt,
 * spectral whitening and a fixed-dictionary multiplicative NNLS.
 */
export function chromaFromSpectrogram(C: Float32Array, T: number, onFraction?: FractionFn): { treble: Float32Array; bass: Float32Array } {
  const N = N_SEMITONES
  const filtered = T > 5 ? medianFilterTime(C, T, N_LOG_BINS, 5) : C
  const { W, rowPtr, colIdx, vals } = noteDictionary()
  const prof = trebleBassProfiles()
  const treble = new Float32Array(T * 12)
  const bass = new Float32Array(T * 12)
  const S = new Float64Array(N)
  const V = new Float64Array(N)
  const H = new Float64Array(N)
  const WtV = new Float64Array(N)
  const bg = new Float64Array(N)
  const report = Math.max(1, Math.floor(T / 25))
  for (let t = 0; t < T; t++) {
    const row = t * N_LOG_BINS
    for (let s = 0; s < N; s++) {
      const b = row + s * BINS_PER_SEMITONE
      S[s] = Math.sqrt(Math.max(filtered[b], filtered[b + 1], filtered[b + 2]))
    }
    // whitening: subtract the slowly varying background (uniform filter, size 18, nearest edges)
    for (let s = 0; s < N; s++) {
      let acc = 0
      for (let d = -9; d <= 8; d++) {
        const k = s + d < 0 ? 0 : s + d >= N ? N - 1 : s + d
        acc += S[k]
      }
      bg[s] = acc / 18
    }
    let any = false
    for (let s = 0; s < N; s++) {
      V[s] = Math.max(S[s] - 0.6 * bg[s], 0)
      if (V[s] > 0) any = true
    }
    if (!any) continue
    // W^T V
    for (let n = 0; n < N; n++) {
      let acc = 0
      for (let s = 0; s < N; s++) acc += W[s * N + n] * V[s]
      WtV[n] = acc
      H[n] = Math.max(acc, 1e-9)
    }
    for (let it = 0; it < NNLS_ITERATIONS; it++) {
      for (let n = 0; n < N; n++) {
        let acc = 0
        for (let p = rowPtr[n]; p < rowPtr[n + 1]; p++) acc += vals[p] * H[colIdx[p]]
        bg[n] = acc // reuse as (W^T W H)
      }
      for (let n = 0; n < N; n++) H[n] *= WtV[n] / (bg[n] + 1e-9)
    }
    for (let n = 0; n < N; n++) {
      const pc = (FMIN_MIDI + n) % 12
      treble[t * 12 + pc] += H[n] * prof.treble[n]
      bass[t * 12 + pc] += H[n] * prof.bass[n]
    }
    if (onFraction && t % report === 0) onFraction(t / T)
  }
  return { treble, bass }
}

/** Full harmonic feature extraction from 22.05 kHz mono audio. */
export function chromaFeatures(y: Float32Array, tuning?: number, onFraction?: FractionFn): ChromaFeatures {
  const tun = tuning ?? estimateTuning(y)
  const T = frameCount(y.length)
  const C = logFrequencySpectrogram(y, tun, onFraction ? (f) => onFraction(0.8 * f) : undefined)
  const { treble, bass } = chromaFromSpectrogram(C, T, onFraction ? (f) => onFraction(0.8 + 0.2 * f) : undefined)
  return { T, fps: FPS, treble, bass, tuning: tun }
}
