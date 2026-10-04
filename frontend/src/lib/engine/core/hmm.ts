// Sequence decoding with log potentials: a general Viterbi for small models and O(T*K)
// Viterbi / forward-backward for "sticky" models (staying is free, any switch costs
// the same, plus an optional per-frame extra cost such as an off-beat penalty).

/**
 * MAP state path of a linear-chain model.
 * unary: (T x K) row-major log potentials; trans: (K x K) log potential of i -> j;
 * init: (K) log prior of the first state; changePen[t] is subtracted from every switch into frame t.
 */
export function viterbi(
  unary: ArrayLike<number>,
  T: number,
  K: number,
  trans: ArrayLike<number>,
  init?: ArrayLike<number>,
  changePen?: ArrayLike<number>,
): Int32Array {
  const path = new Int32Array(T)
  if (T === 0) return path
  let score = new Float64Array(K)
  let next = new Float64Array(K)
  const back = new Int32Array(T * K)
  for (let k = 0; k < K; k++) score[k] = unary[k] + (init ? init[k] : 0)
  for (let t = 1; t < T; t++) {
    const pen = changePen ? changePen[t] : 0
    for (let j = 0; j < K; j++) {
      let best = -Infinity
      let arg = 0
      for (let i = 0; i < K; i++) {
        const v = score[i] + trans[i * K + j] - (i === j ? 0 : pen)
        if (v > best) {
          best = v
          arg = i
        }
      }
      next[j] = best + unary[t * K + j]
      back[t * K + j] = arg
    }
    const tmp = score
    score = next
    next = tmp
  }
  let arg = 0
  for (let k = 1; k < K; k++) if (score[k] > score[arg]) arg = k
  path[T - 1] = arg
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t * K + path[t]]
  return path
}

/**
 * Viterbi for a sticky model: log trans(i -> j) = 0 if i == j else -(switchCost + changePen[t]).
 * Equivalent to `viterbi` with that transition matrix, in O(T*K).
 */
export function viterbiSticky(
  unary: ArrayLike<number>,
  T: number,
  K: number,
  switchCost: number,
  changePen?: ArrayLike<number>,
): Int32Array {
  const path = new Int32Array(T)
  if (T === 0) return path
  let score = new Float64Array(K)
  let next = new Float64Array(K)
  const switched = new Uint8Array(T * K)
  const bestPrev = new Int32Array(T)
  for (let k = 0; k < K; k++) score[k] = unary[k]
  for (let t = 1; t < T; t++) {
    let arg = 0
    for (let k = 1; k < K; k++) if (score[k] > score[arg]) arg = k
    bestPrev[t] = arg
    const viaSwitch = score[arg] - switchCost - (changePen ? changePen[t] : 0)
    for (let j = 0; j < K; j++) {
      const stay = score[j]
      if (viaSwitch > stay) {
        next[j] = viaSwitch + unary[t * K + j]
        switched[t * K + j] = 1
      } else {
        next[j] = stay + unary[t * K + j]
      }
    }
    const tmp = score
    score = next
    next = tmp
  }
  let arg = 0
  for (let k = 1; k < K; k++) if (score[k] > score[arg]) arg = k
  path[T - 1] = arg
  for (let t = T - 1; t > 0; t--) {
    const j = path[t]
    path[t - 1] = switched[t * K + j] ? bestPrev[t] : j
  }
  return path
}

/** Per-frame state posteriors (T x K) of the sticky model (forward-backward, rescaled per frame). */
export function posteriorsSticky(
  unary: ArrayLike<number>,
  T: number,
  K: number,
  switchCost: number,
  changePen?: ArrayLike<number>,
): Float32Array {
  const post = new Float32Array(T * K)
  if (T === 0) return post
  // alpha / beta kept in the linear domain, rescaled to max 1 per frame (log offsets dropped:
  // the posteriors are invariant to per-frame constants)
  const alpha = new Float64Array(T * K)
  const beta = new Float64Array(T * K)
  const e = new Float64Array(K)
  const expRow = (t: number, extra: Float64Array | null): void => {
    let m = -Infinity
    for (let k = 0; k < K; k++) {
      const v = unary[t * K + k] + (extra ? extra[k] : 0)
      e[k] = v
      if (v > m) m = v
    }
    for (let k = 0; k < K; k++) e[k] = Math.exp(e[k] - m)
  }
  expRow(0, null)
  alpha.set(e, 0)
  const logPrev = new Float64Array(K)
  for (let t = 1; t < T; t++) {
    const c = Math.exp(-(switchCost + (changePen ? changePen[t] : 0)))
    let s = 0
    for (let k = 0; k < K; k++) s += alpha[(t - 1) * K + k]
    for (let k = 0; k < K; k++) {
      const a = alpha[(t - 1) * K + k]
      logPrev[k] = Math.log(Math.max(a * (1 - c) + c * s, 1e-300))
    }
    expRow(t, logPrev)
    alpha.set(e, t * K)
  }
  for (let k = 0; k < K; k++) beta[(T - 1) * K + k] = 1
  const b = new Float64Array(K)
  for (let t = T - 2; t >= 0; t--) {
    const c = Math.exp(-(switchCost + (changePen ? changePen[t + 1] : 0)))
    // b_j = exp(unary[t+1, j]) * beta[t+1, j], rescaled
    let m = -Infinity
    for (let k = 0; k < K; k++) {
      const v = unary[(t + 1) * K + k] + Math.log(Math.max(beta[(t + 1) * K + k], 1e-300))
      b[k] = v
      if (v > m) m = v
    }
    let s = 0
    for (let k = 0; k < K; k++) {
      b[k] = Math.exp(b[k] - m)
      s += b[k]
    }
    let top = 0
    for (let k = 0; k < K; k++) {
      const v = b[k] * (1 - c) + c * s
      beta[t * K + k] = v
      if (v > top) top = v
    }
    for (let k = 0; k < K; k++) beta[t * K + k] /= top || 1
  }
  for (let t = 0; t < T; t++) {
    let s = 0
    for (let k = 0; k < K; k++) {
      const v = alpha[t * K + k] * beta[t * K + k]
      post[t * K + k] = v
      s += v
    }
    if (s > 0) for (let k = 0; k < K; k++) post[t * K + k] /= s
    else post.fill(1 / K, t * K, t * K + K)
  }
  return post
}
