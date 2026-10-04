// Incremental harmonic features for live analysis: the offline engine's log-frequency spectrum
// (same band kernels, windows and tuning), its median-filter percussion suppression and its NNLS
// treble/bass chroma, computed frame by frame as 22.05 kHz audio arrives.
//
// With the default options a frame equals the offline `chromaFeatures()` frame exactly; it is
// emitted once its windows (and the median filter's look-ahead) are filled:
//   bass window 16384 / 2 + 2 frames of median look-ahead -> ~0.56 s after the frame time.
// `bassLag` trades a little bass precision for latency by centering the long bass window that
// many hops earlier (the treble window then dominates the delay: ~0.37 s).

import {
  BANDS, BINS_PER_SEMITONE, FMIN_MIDI, FPS, HOP, N_LOG_BINS, SR, buildBand, chromaFromSpectrogram, midiToHz,
  windowFrame, type BandKernel,
} from '../../engine/core/spectrum.ts'
import { medianFilterTime } from '../../engine/core/util.ts'

/** Offline percussion-suppression median size (frames). */
export const OFFLINE_MEDIAN = 5
/** Half of the offline frame RMS window (frameRmsDb with win = 0.2 s at 22.05 kHz). */
const RMS_HALF = Math.floor((0.2 * SR) / 2)

export interface StreamingChromaOptions {
  /** reference-pitch offset in semitones (see estimateTuning); can be changed later with setTuning */
  tuning?: number
  /** odd median-filter length in frames (offline: 5); 1 disables it */
  medianSize?: number
  /** center the bass band's window this many hops earlier (0 = identical to offline) */
  bassLag?: number
}

export interface ChromaFrame {
  /** frame index; the frame is centered at index * HOP / SR seconds */
  index: number
  time: number
  /** 12 values, the same as row `index` of the offline ChromaFeatures */
  treble: Float32Array
  bass: Float32Array
  /** loudness of the 0.2 s around the frame (dBFS), as the offline frameRmsDb */
  rmsDb: number
}

interface Band {
  kernel: BandKernel
  /** window center offset (samples) relative to the frame center */
  offset: number
}

interface RawFrame {
  index: number
  spec: Float32Array
  rmsDb: number
}

export class StreamingChroma {
  private bands: Band[] = []
  private tuningValue: number
  private readonly median: number
  private readonly bassLag: number
  /** samples [bufStart, bufStart + bufLen) */
  private buf = new Float32Array(1 << 16)
  private bufStart = 0
  private bufLen = 0
  private received = 0
  /** next raw (unfiltered) frame to compute */
  private nextRaw = 0
  /** next filtered frame to emit */
  private nextOut = 0
  /** recent raw frames (enough for one median window) */
  private raw: RawFrame[] = []
  private flushed = false

  constructor(options: StreamingChromaOptions = {}) {
    this.tuningValue = options.tuning ?? 0
    const m = Math.max(1, Math.floor(options.medianSize ?? OFFLINE_MEDIAN))
    this.median = m % 2 ? m : m + 1
    this.bassLag = Math.max(0, Math.floor(options.bassLag ?? 0))
    this.buildBands()
  }

  get tuning(): number {
    return this.tuningValue
  }

  /** Samples received so far (22.05 kHz). */
  get sampleCount(): number {
    return this.received
  }

  /** Frames emitted so far. */
  get frameCount(): number {
    return this.nextOut
  }

  /** Frames are emitted this long (s) after their center time (window + median look-ahead). */
  get delay(): number {
    return (this.lookahead() + (this.median >> 1) * HOP) / SR
  }

  /** Use a new reference pitch from the next computed frame on. */
  setTuning(tuning: number): void {
    if (!Number.isFinite(tuning) || tuning === this.tuningValue) return
    this.tuningValue = tuning
    this.buildBands()
  }

  /** Feed mono 22.05 kHz samples; returns the frames that became complete. */
  push(y: Float32Array): ChromaFrame[] {
    if (this.flushed) throw new Error('StreamingChroma: push after flush')
    this.append(y)
    const out: ChromaFrame[] = []
    const ahead = this.lookahead()
    while (this.nextRaw * HOP + ahead <= this.received) {
      this.computeRaw(this.nextRaw++)
      this.emit(out, false, false)
    }
    return out
  }

  /**
   * End of input: computes the remaining frames with the offline engine's edge handling (windows
   * zero-padded past the end, median filter repeating the last frame).
   */
  flush(): ChromaFrame[] {
    if (this.flushed) return []
    this.flushed = true
    const total = 1 + Math.floor(this.received / HOP)
    // the offline median filter skips signals of <= 5 frames
    const plain = total <= OFFLINE_MEDIAN && this.nextOut === 0
    const out: ChromaFrame[] = []
    while (this.nextRaw < total) {
      this.computeRaw(this.nextRaw++)
      if (!plain) this.emit(out, false, false)
    }
    this.emit(out, true, plain)
    return out
  }

  private lookahead(): number {
    let ahead = RMS_HALF
    for (const b of this.bands) ahead = Math.max(ahead, b.offset + (b.kernel.win.length >> 1))
    return ahead
  }

  private buildBands(): void {
    // same partition and bin centers as logFrequencySpectrogram()
    const freqs = new Float64Array(N_LOG_BINS)
    for (let b = 0; b < N_LOG_BINS; b++) {
      freqs[b] = midiToHz(FMIN_MIDI + this.tuningValue + (b - 1) / BINS_PER_SEMITONE)
    }
    const bands: Band[] = []
    let lo = 0
    BANDS.forEach((band, i) => {
      const bins: number[] = []
      for (let b = lo; b < N_LOG_BINS; b++) {
        if (FMIN_MIDI + Math.floor(b / BINS_PER_SEMITONE) >= band.maxMidi) break
        bins.push(b)
      }
      // only the first (longest) band is the bass band
      if (bins.length) bands.push({ kernel: buildBand(band.size, bins, freqs), offset: i === 0 ? -this.bassLag * HOP : 0 })
      lo += bins.length
    })
    this.bands = bands
  }

  private append(y: Float32Array): void {
    if (this.bufLen + y.length > this.buf.length) {
      this.compact()
      if (this.bufLen + y.length > this.buf.length) {
        const next = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + y.length))
        next.set(this.buf.subarray(0, this.bufLen))
        this.buf = next
      }
    }
    this.buf.set(y, this.bufLen)
    this.bufLen += y.length
    this.received += y.length
  }

  /** Drop samples no future frame reads. */
  private compact(): void {
    let reach = RMS_HALF
    for (const b of this.bands) reach = Math.max(reach, (b.kernel.win.length >> 1) - b.offset)
    const keepFrom = Math.max(0, this.nextRaw * HOP - reach - 1)
    const drop = Math.min(this.bufLen, keepFrom - this.bufStart)
    if (drop <= 0) return
    this.buf.copyWithin(0, drop, this.bufLen)
    this.bufLen -= drop
    this.bufStart += drop
  }

  private computeRaw(t: number): void {
    // A view of the buffered signal; windowFrame zero-pads outside it. Frames computed before
    // the end of input never reach past it, and the start is only padded while nothing has
    // been dropped yet, which is exactly the offline zero padding.
    const y = this.buf.subarray(0, this.bufLen)
    const center = t * HOP - this.bufStart
    const spec = new Float32Array(N_LOG_BINS)
    for (const { kernel: k, offset } of this.bands) {
      windowFrame(y, center + offset, k.win, k.buf)
      k.fft.power(k.buf, k.power)
      const P = k.power
      for (const b of k.bins) {
        let s = 0
        const s0 = k.start[b]
        const s1 = s0 + k.count[b]
        for (let i = s0; i < s1; i++) s += k.w[i] * P[k.idx[i]]
        spec[b] = Math.sqrt(s) * k.scale
      }
    }
    // frameRmsDb(x, SR, FPS, T, 0.2) for frame t
    const lo = Math.max(0, Math.min(this.received, t * HOP - RMS_HALF))
    const hi = Math.max(0, Math.min(this.received, t * HOP + RMS_HALF))
    let e = 0
    for (let k = lo; k < hi; k++) {
      const v = this.buf[k - this.bufStart]
      e += v * v
    }
    e /= Math.max(hi - lo, 1)
    this.raw.push({ index: t, spec, rmsDb: 10 * Math.log10(e + 1e-12) })
    const keep = this.median + 1
    if (this.raw.length > keep) this.raw.splice(0, this.raw.length - keep)
  }

  private rawAt(t: number): RawFrame {
    // 'nearest' edges: before the first frame, and past the last one when flushing
    const first = this.raw[0]
    const last = this.raw[this.raw.length - 1]
    const i = Math.min(Math.max(t, 0), last.index) - first.index
    if (i < 0) throw new Error(`StreamingChroma: frame ${t} is no longer buffered`)
    return this.raw[i]
  }

  /** Emit the filtered frames whose median window is complete (all of them when `final`). */
  private emit(out: ChromaFrame[], final: boolean, plain: boolean): void {
    const h = this.median >> 1
    const D = N_LOG_BINS
    while (this.nextOut < this.nextRaw && (final || this.nextOut + h < this.nextRaw)) {
      const t = this.nextOut++
      const center = this.rawAt(t)
      let row: Float32Array
      if (this.median <= 1 || plain) {
        row = center.spec
      } else {
        const block = new Float32Array(this.median * D)
        for (let k = -h; k <= h; k++) block.set(this.rawAt(t + k).spec, (k + h) * D)
        row = medianFilterTime(block, this.median, D, this.median).subarray(h * D, (h + 1) * D)
      }
      const { treble, bass } = chromaFromSpectrogram(row, 1)
      out.push({ index: t, time: t / FPS, treble, bass, rmsDb: center.rmsDb })
    }
  }
}
