import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, getVocabulary } from '../../engine/core/analyze.ts'
import { posteriorsSticky, viterbiSticky } from '../../engine/core/hmm.ts'
import { absorbShort, mergeEqual, pathToSegments, type Segment } from '../../engine/core/segments.ts'
import { FPS, SR, chromaFeatures, estimateTuning } from '../../engine/core/spectrum.ts'
import { percentile } from '../../engine/core/util.ts'
import { frameRmsDb } from '../../engine/core/waveform.ts'
import { rng } from '../../engine/testing/synth.ts'
import { SONGS, renderSong } from '../testing/songs.ts'
import { OnlineChordDecoder, type DecodedRun } from './decoder.ts'
import { frameScores } from './scores.ts'

const vocab = getVocabulary()
const K = vocab.chords.length + 1
const MIN_FRAMES = Math.ceil(0.45 * FPS - 1e-9)

/** Offline score matrix of a song (exactly the engine's decodeChords input, without beat penalties). */
function offlineScores(audio: Float32Array): { U: Float32Array; T: number } {
  const chroma = chromaFeatures(audio, estimateTuning(audio))
  const { T } = chroma
  const rms = frameRmsDb(audio, SR, chroma.fps, T)
  const thr = Math.max(DEFAULT_PARAMS.silenceDb, percentile(rms, 95) - 45)
  const U = new Float32Array(T * K)
  const row = new Float32Array(K)
  for (let t = 0; t < T; t++) {
    frameScores(chroma.treble.subarray(t * 12, t * 12 + 12), chroma.bass.subarray(t * 12, t * 12 + 12), rms[t] < thr, vocab, DEFAULT_PARAMS, row)
    U.set(row, t * K)
  }
  return { U, T }
}

/** Offline decoding: Viterbi path, then the engine's minimum-duration cleanup (posterior scored). */
function offlinePath(U: Float32Array, T: number): { viterbi: Int32Array; cleaned: Int32Array } {
  const viterbi = viterbiSticky(U, T, K, DEFAULT_PARAMS.changePenalty)
  const post = posteriorsSticky(U, T, K, DEFAULT_PARAMS.changePenalty)
  const score = (seg: Segment, state: number) => {
    let s = 0
    for (let t = seg.first; t < seg.last; t++) s += post[t * K + state]
    return s / Math.max(1, seg.last - seg.first)
  }
  let segs = mergeEqual(pathToSegments(viterbi, FPS, T / FPS))
  segs = mergeEqual(absorbShort(segs, MIN_FRAMES / FPS - 1e-6, score))
  const cleaned = new Int32Array(T)
  for (const s of segs) cleaned.fill(s.state, s.first, s.last)
  return { viterbi, cleaned }
}

function runsToPath(runs: DecodedRun[], T: number): Int32Array {
  const path = new Int32Array(T).fill(-1)
  for (const r of runs) path.fill(r.state, r.first, r.last)
  return path
}

function share(a: Int32Array, b: Int32Array): number {
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return same / a.length
}

interface Trace {
  finals: DecodedRun[]
  /** per pushed frame: the decoder's open runs after the push */
  opens: DecodedRun[][]
}

function decode(U: Float32Array, T: number, lag: number, minFrames = MIN_FRAMES): Trace {
  const dec = new OnlineChordDecoder({ K, lag, switchCost: DEFAULT_PARAMS.changePenalty, minFrames })
  const finals: DecodedRun[] = []
  const opens: DecodedRun[][] = []
  for (let t = 0; t < T; t++) {
    dec.push(U.subarray(t * K, (t + 1) * K))
    finals.push(...dec.takeFinal())
    opens.push(dec.open())
  }
  finals.push(...dec.finish())
  return { finals, opens }
}

describe('OnlineChordDecoder vs offline Viterbi', () => {
  const songs = SONGS.map((spec) => {
    const song = renderSong(spec, SR)
    return { name: spec.name, ...offlineScores(song.audio) }
  })

  for (const lag of [6, 8, 11]) {
    it(`agrees with the offline decoder on synthesized progressions (lag ${lag} frames ≈ ${(lag / FPS).toFixed(2)} s)`, () => {
      for (const { name, U, T } of songs) {
        const { viterbi, cleaned } = offlinePath(U, T)
        const live = runsToPath(decode(U, T, lag).finals, T)
        const raw = share(live, viterbi)
        const clean = share(live, cleaned)
        expect(raw, `${name}: vs Viterbi`).toBeGreaterThanOrEqual(0.9)
        expect(clean, `${name}: vs Viterbi + cleanup`).toBeGreaterThanOrEqual(0.95)
      }
    })
  }
})

describe('OnlineChordDecoder provisional -> final', () => {
  const { U, T } = offlineScores(renderSong(SONGS[0], SR).audio)
  const lag = 8
  const trace = decode(U, T, lag)

  it('final runs are contiguous, never revised and cover every frame at the end', () => {
    let next = 0
    for (const r of trace.finals) {
      expect(r.first).toBe(next)
      expect(r.last).toBeGreaterThan(r.first)
      expect(r.final).toBe(true)
      expect(r.confirmed).toBe(true)
      next = r.last
    }
    expect(next).toBe(T)
    // the cleanup leaves no short run in the middle
    for (const r of trace.finals.slice(1, -1)) expect(r.last - r.first).toBeGreaterThanOrEqual(MIN_FRAMES)
  })

  it('always reports a current chord covering the newest frame, provisional until the lag has passed', () => {
    trace.opens.forEach((open, t) => {
      expect(open.length).toBeGreaterThan(0)
      const cur = open[open.length - 1]
      expect(cur.last).toBe(t + 1)
      // a run younger than the lag cannot be confirmed yet
      if (t + 1 - cur.first <= lag) expect(cur.confirmed).toBe(false)
      for (const r of open) expect(r.final).toBe(false)
    })
  })

  it('switches the current chord within a few frames of the evidence, long before it is final', () => {
    // frames where the offline path changes state
    const { cleaned } = offlinePath(U, T)
    const changes: number[] = []
    for (let t = 1; t < T; t++) if (cleaned[t] !== cleaned[t - 1]) changes.push(t)
    expect(changes.length).toBeGreaterThan(5)
    for (const c of changes) {
      const want = cleaned[c]
      let seen = -1
      for (let t = c; t < Math.min(T, c + 20); t++) {
        const cur = trace.opens[t][trace.opens[t].length - 1]
        if (cur.state === want) {
          seen = t
          break
        }
      }
      expect(seen - c).toBeGreaterThanOrEqual(0)
      expect(seen - c).toBeLessThanOrEqual(2)
      // ...and final only after the smoothing lag
      const fin = trace.finals.find((r) => r.first <= c + 1 && c + 1 < r.last)
      expect(fin?.state).toBe(want)
    }
  })

  it('confirmed labels never change', () => {
    const confirmed = new Map<number, number>() // first frame -> state
    trace.opens.forEach((open) => {
      for (const r of open) {
        if (!r.confirmed) continue
        const seen = confirmed.get(r.first)
        if (seen !== undefined) expect(r.state).toBe(seen)
        confirmed.set(r.first, r.state)
      }
    })
    for (const r of trace.finals) {
      const seen = confirmed.get(r.first)
      if (seen !== undefined) expect(r.state).toBe(seen)
    }
  })
})

describe('OnlineChordDecoder on toy models', () => {
  function toy(states: number[], k = 3, strength = 3): Float32Array {
    const U = new Float32Array(states.length * k)
    states.forEach((s, t) => {
      for (let j = 0; j < k; j++) U[t * k + j] = j === s ? 0 : -strength
    })
    return U
  }

  it('absorbs blips shorter than the minimum duration', () => {
    const states = [...Array(20).fill(0), 1, 1, ...Array(20).fill(0), ...Array(20).fill(2)]
    const U = toy(states, 3, 12) // strong enough to beat the switch cost
    const dec = new OnlineChordDecoder({ K: 3, lag: 4, switchCost: 9, minFrames: 5 })
    const finals: DecodedRun[] = []
    for (let t = 0; t < states.length; t++) {
      dec.push(U.subarray(t * 3, t * 3 + 3))
      finals.push(...dec.takeFinal())
    }
    finals.push(...dec.finish())
    expect(finals.map((r) => [r.state, r.first, r.last])).toEqual([
      [0, 0, 42],
      [2, 42, 62],
    ])
  })

  it('a sticky model ignores single noisy frames even before smoothing', () => {
    const random = rng(4)
    const states = Array.from({ length: 60 }, (_, t) => (t < 30 ? 0 : 1))
    const U = toy(states, 3, 1.2)
    U[10 * 3 + 2] = 2 // one frame strongly favours state 2
    const dec = new OnlineChordDecoder({ K: 3, lag: 6, switchCost: 9, minFrames: 4 })
    const currents: number[] = []
    for (let t = 0; t < states.length; t++) {
      const row = U.subarray(t * 3, t * 3 + 3).map((v) => v + 0.01 * random())
      dec.push(row)
      const open = dec.open()
      currents.push(open[open.length - 1].state)
    }
    expect(currents.slice(0, 30).every((s) => s === 0)).toBe(true)
    expect(currents.slice(-15).every((s) => s === 1)).toBe(true)
    const finals = [...dec.takeFinal(), ...dec.finish()]
    expect(finals.map((r) => r.state)).toEqual([0, 1])
  })

  it('commits a frame only after `lag` newer frames', () => {
    const dec = new OnlineChordDecoder({ K: 2, lag: 5, switchCost: 9, minFrames: 1 })
    for (let t = 0; t < 12; t++) {
      dec.push([0, -1])
      expect(dec.committedFrames).toBe(Math.max(0, t + 1 - 5))
    }
  })
})
