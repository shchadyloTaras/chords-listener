// Real time only (no fake clocks): a bound is checked by trying once a second until it holds or the bound passes.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface Waited<T> {
  /** what the last attempt returned (the one that satisfied `done`, or the last before the bound) */
  value: T
  /** seconds from `since` to the attempt that satisfied `done` (or to the bound) */
  seconds: number
  /** attempts made */
  attempts: number
  ok: boolean
}

/**
 * Calls `attempt` once a second (a slow attempt delays the next one) until `done(value)` or `boundS` seconds after
 * `since` (ms since epoch; default now). Never throws on a miss: the caller asserts `ok` and reports `seconds`.
 */
export async function everySecondUntil<T>(
  attempt: () => Promise<T>,
  done: (value: T) => boolean,
  { boundS, since = Date.now(), intervalMs = 1000 }: { boundS: number; since?: number; intervalMs?: number },
): Promise<Waited<T>> {
  let attempts = 0
  for (;;) {
    const started = Date.now()
    const value = await attempt()
    attempts += 1
    const seconds = (Date.now() - since) / 1000
    if (done(value)) return { value, seconds, attempts, ok: true }
    if (seconds >= boundS) return { value, seconds, attempts, ok: false }
    await sleep(Math.max(0, intervalMs - (Date.now() - started)))
  }
}

/** Nearest-rank percentile of `values` (p95 of 20 values is the 19th smallest). */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}
