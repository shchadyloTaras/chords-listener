import { describe, expect, it } from 'vitest'
import { HOP, SR, chromaFeatures, estimateTuning } from '../../engine/core/spectrum.ts'
import { frameRmsDb } from '../../engine/core/waveform.ts'
import { renderProgression, rng } from '../../engine/testing/synth.ts'
import { StreamingChroma, type ChromaFrame } from './features.ts'

const SONG = renderProgression(
  [
    { notes: [60, 64, 67], bass: 36 },
    { notes: [59, 62, 67], bass: 43 },
    { notes: [57, 60, 64], bass: 45 },
    { notes: [57, 60, 65], bass: 41 },
  ],
  { sr: SR, bpm: 120, beatsPerChord: 4, leadIn: 0.5, tail: 0.8 },
)

function feed(x: Float32Array, sc: StreamingChroma, seed: number, onFrames?: (frames: ChromaFrame[], received: number) => void): ChromaFrame[] {
  const r = rng(seed)
  const frames: ChromaFrame[] = []
  let received = 0
  for (let i = 0; i < x.length; ) {
    const n = 1 + Math.floor(r() * 3000)
    const part = x.subarray(i, i + n)
    received += part.length
    const got = sc.push(part)
    onFrames?.(got, received)
    frames.push(...got)
    i += n
  }
  frames.push(...sc.flush())
  return frames
}

function maxRelErr(a: Float32Array, b: Float32Array): number {
  let scale = 0
  for (let i = 0; i < b.length; i++) scale = Math.max(scale, Math.abs(b[i]))
  let err = 0
  for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]))
  return err / Math.max(scale, 1e-12)
}

describe('StreamingChroma', () => {
  it('reproduces the offline chroma frame for frame (random chunk sizes)', () => {
    const y = SONG.audio
    const tuning = estimateTuning(y)
    const ref = chromaFeatures(y, tuning)
    const frames = feed(y, new StreamingChroma({ tuning }), 5)
    expect(frames.length).toBe(ref.T)
    const treble = new Float32Array(ref.T * 12)
    const bass = new Float32Array(ref.T * 12)
    frames.forEach((f, t) => {
      expect(f.index).toBe(t)
      expect(f.time).toBeCloseTo((t * HOP) / SR, 9)
      treble.set(f.treble, t * 12)
      bass.set(f.bass, t * 12)
    })
    expect(maxRelErr(treble, ref.treble)).toBeLessThan(1e-6)
    expect(maxRelErr(bass, ref.bass)).toBeLessThan(1e-6)
    // loudness used for silence detection = offline frameRmsDb
    const rms = frameRmsDb(y, SR, ref.fps, ref.T)
    frames.forEach((f, t) => expect(f.rmsDb).toBeCloseTo(rms[t], 6))
  })

  it('matches with a detuned reference pitch too', () => {
    const y = SONG.audio.subarray(0, 4 * SR)
    const ref = chromaFeatures(y, -0.31)
    const frames = feed(y, new StreamingChroma({ tuning: -0.31 }), 9)
    const treble = new Float32Array(ref.T * 12)
    frames.forEach((f, t) => treble.set(f.treble, t * 12))
    expect(maxRelErr(treble, ref.treble)).toBeLessThan(1e-6)
  })

  it('emits each frame as soon as its windows and the median look-ahead are filled', () => {
    const sc = new StreamingChroma()
    expect(sc.delay).toBeCloseTo((8192 + 2 * HOP) / SR, 9) // ~0.557 s
    feed(SONG.audio.subarray(0, 3 * SR), sc, 2, (frames, received) => {
      for (const f of frames) {
        const readyAt = f.index * HOP + sc.delay * SR
        expect(readyAt).toBeLessThanOrEqual(received)
      }
      // nothing that was ready is held back
      const next = sc.frameCount
      expect(next * HOP + sc.delay * SR).toBeGreaterThan(received)
    })
  })

  it('a bass lag lowers the delay and keeps the features close to offline away from changes', () => {
    const y = SONG.audio
    const tuning = estimateTuning(y)
    const ref = chromaFeatures(y, tuning)
    const sc = new StreamingChroma({ tuning, bassLag: 2 })
    expect(sc.delay).toBeCloseTo((4096 + 2 * HOP) / SR, 9) // ~0.37 s
    const frames = feed(y, sc, 7)
    expect(frames.length).toBe(ref.T)
    const cos = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      let ab = 0
      let aa = 0
      let bb = 0
      for (let i = 0; i < 12; i++) {
        ab += a[i] * b[i]
        aa += a[i] * a[i]
        bb += b[i] * b[i]
      }
      return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1
    }
    const argmax = (v: ArrayLike<number>) => Array.from(v).reduce((m, x, i, arr) => (x > arr[m] ? i : m), 0)
    let same = 0
    let total = 0
    let trebleCos = 0
    for (let t = 10; t < ref.T - 10; t++) {
      const time = t / ref.fps
      if (SONG.changes.some((c) => Math.abs(c - time) < 0.5)) continue
      total++
      trebleCos += cos(frames[t].treble, ref.treble.subarray(t * 12, t * 12 + 12))
      if (argmax(frames[t].bass) === argmax(ref.bass.subarray(t * 12, t * 12 + 12))) same++
    }
    expect(trebleCos / total).toBeGreaterThan(0.98)
    expect(same / total).toBeGreaterThan(0.95)
  })

  it('follows a tuning change from the next frame on', () => {
    const sc = new StreamingChroma()
    sc.push(SONG.audio.subarray(0, SR))
    sc.setTuning(0.2)
    expect(sc.tuning).toBe(0.2)
    expect(sc.push(SONG.audio.subarray(SR, 2 * SR)).length).toBeGreaterThan(5)
  })
})
