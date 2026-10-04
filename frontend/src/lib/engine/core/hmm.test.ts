import { describe, expect, it } from 'vitest'
import { rng } from '../testing/synth.ts'
import { posteriorsSticky, viterbi, viterbiSticky } from './hmm.ts'

/** All K^T paths with their total log score (tiny models only). */
function enumerate(unary: Float64Array, T: number, K: number, trans: (t: number, i: number, j: number) => number,
  init?: Float64Array): { path: number[]; score: number }[] {
  const out: { path: number[]; score: number }[] = []
  const path = new Array<number>(T).fill(0)
  const rec = (t: number, score: number) => {
    if (t === T) {
      out.push({ path: path.slice(), score })
      return
    }
    for (let k = 0; k < K; k++) {
      path[t] = k
      const s = t === 0 ? unary[k] + (init ? init[k] : 0) : score + trans(t, path[t - 1], k) + unary[t * K + k]
      rec(t + 1, s)
    }
  }
  rec(0, 0)
  return out
}

describe('viterbi', () => {
  it('decodes the classic healthy/fever toy HMM', () => {
    // states: 0 healthy, 1 fever; observations: normal, cold, dizzy
    const emit = [[0.5, 0.4, 0.1], [0.1, 0.3, 0.6]]
    const trans = Float64Array.from([0.7, 0.3, 0.4, 0.6].map(Math.log))
    const init = Float64Array.from([0.6, 0.4].map(Math.log))
    const obs = [0, 1, 2]
    const unary = Float64Array.from(obs.flatMap((o) => [Math.log(emit[0][o]), Math.log(emit[1][o])]))
    expect(Array.from(viterbi(unary, 3, 2, trans, init))).toEqual([0, 0, 1])
  })

  it('finds the best path of a random model (brute force check)', () => {
    const random = rng(5)
    const T = 6
    const K = 3
    const unary = Float64Array.from({ length: T * K }, () => -3 * random())
    const trans = Float64Array.from({ length: K * K }, () => -2 * random())
    const init = Float64Array.from({ length: K }, () => -random())
    const pen = Float64Array.from({ length: T }, () => random())
    const best = enumerate(unary, T, K, (t, i, j) => trans[i * K + j] - (i === j ? 0 : pen[t]), init)
      .reduce((a, b) => (b.score > a.score ? b : a))
    expect(Array.from(viterbi(unary, T, K, trans, init, pen))).toEqual(best.path)
  })

  it('sticky decoding equals the general decoder with the same transitions', () => {
    const random = rng(9)
    for (let trial = 0; trial < 5; trial++) {
      const T = 80
      const K = 7
      const unary = Float64Array.from({ length: T * K }, () => -6 * random())
      const pen = Float64Array.from({ length: T }, () => (random() < 0.5 ? 0 : 3 * random()))
      const cost = 2 + 4 * random()
      const trans = Float64Array.from({ length: K * K }, (_, k) => (Math.floor(k / K) === k % K ? 0 : -cost))
      expect(Array.from(viterbiSticky(unary, T, K, cost, pen))).toEqual(Array.from(viterbi(unary, T, K, trans, undefined, pen)))
    }
  })

  it('a high self-transition preference smooths out single-frame blips', () => {
    const T = 20
    const K = 2
    const unary = new Float64Array(T * K)
    for (let t = 0; t < T; t++) {
      const s = t < 10 ? 0 : 1
      unary[t * K + s] = 0
      unary[t * K + (1 - s)] = -1
    }
    unary[5 * K + 1] = 0.5 // one noisy frame
    unary[5 * K + 0] = -0.5
    const path = Array.from(viterbiSticky(unary, T, K, 5))
    expect(path).toEqual([...new Array(10).fill(0), ...new Array(10).fill(1)])
  })
})

describe('posteriorsSticky', () => {
  it('matches brute-force marginals', () => {
    const random = rng(13)
    const T = 6
    const K = 3
    const cost = 1.5
    const unary = Float64Array.from({ length: T * K }, () => -2 * random())
    const pen = Float64Array.from({ length: T }, () => random())
    const paths = enumerate(unary, T, K, (t, i, j) => (i === j ? 0 : -(cost + pen[t])))
    const z = paths.reduce((s, p) => s + Math.exp(p.score), 0)
    const ref = new Float64Array(T * K)
    for (const p of paths) p.path.forEach((k, t) => (ref[t * K + k] += Math.exp(p.score) / z))
    const post = posteriorsSticky(unary, T, K, cost, pen)
    for (let i = 0; i < T * K; i++) expect(post[i]).toBeCloseTo(ref[i], 5)
  })

  it('rows are probability distributions even for long, peaky inputs', () => {
    const random = rng(21)
    const T = 3000
    const K = 25
    const unary = Float32Array.from({ length: T * K }, () => -40 * random())
    const post = posteriorsSticky(unary, T, K, 9)
    for (let t = 0; t < T; t += 97) {
      let s = 0
      for (let k = 0; k < K; k++) {
        expect(Number.isFinite(post[t * K + k])).toBe(true)
        s += post[t * K + k]
      }
      expect(s).toBeCloseTo(1, 5)
    }
  })
})
