// The step machine of a running tour (spec §1 "Which steps show", §2 "Movement" and "Seen" state): which
// steps are included right now, next / back, a vanished anchor, close reasons, and the chained tours of a
// re-open. Pure: the page is seen through StepEnv (the flags and which anchors are on screen).
import { conditionHolds, type Tour, type TourFlags, type TourId, type TourStep } from './tours'

export interface StepEnv {
  flags: TourFlags
  /** the anchor is in the page and rendered (the first visible `data-tour` match) */
  present(anchor: string): boolean
}

/** The step on screen and the steps shown before it («Назад», the counter). */
export interface TourRun {
  index: number
  history: readonly number[]
}

/** done = «Готово» (or «Далі» with nothing after); exhausted = the anchors vanished and nothing is left */
export type CloseReason = 'done' | 'skip' | 'escape' | 'exhausted' | 'route'

export type Advance = { run: TourRun } | { end: CloseReason }

export interface Counter {
  ordinal: number
  total: number
  first: boolean
  last: boolean
}

export function stepIncluded(step: TourStep, env: StepEnv): boolean {
  if (step.when && !step.when.every((c) => conditionHolds(c, env.flags))) return false
  return step.anchors.length === 0 || !!step.centre || step.anchors.some((a) => env.present(a))
}

function nextIncluded(tour: Tour, after: number, env: StepEnv): number | null {
  for (let i = after + 1; i < tour.steps.length; i++) if (stepIncluded(tour.steps[i], env)) return i
  return null
}

export function startRun(tour: Tour, env: StepEnv): TourRun | null {
  const index = nextIncluded(tour, -1, env)
  return index === null ? null : { index, history: [] }
}

export function advance(tour: Tour, run: TourRun, env: StepEnv): Advance {
  const index = nextIncluded(tour, run.index, env)
  return index === null ? { end: 'done' } : { run: { index, history: [...run.history, run.index] } }
}

export function goBack(tour: Tour, run: TourRun, env: StepEnv): TourRun | null {
  const history = [...run.history]
  while (history.length) {
    const index = history.pop()!
    if (stepIncluded(tour.steps[index], env)) return { index, history }
  }
  return null
}

/** The step's anchors stayed missing for 300 ms: a centre step stays as a card, any other moves on. */
export function anchorsGone(tour: Tour, run: TourRun, env: StepEnv): Advance {
  if (tour.steps[run.index].centre) return { run }
  const index = nextIncluded(tour, run.index, env)
  return index === null ? { end: 'exhausted' } : { run: { index, history: [...run.history, run.index] } }
}

export function counter(tour: Tour, run: TourRun, env: StepEnv): Counter {
  const before = run.history.filter((i) => stepIncluded(tour.steps[i], env)).length
  let after = 0
  for (let i = run.index + 1; i < tour.steps.length; i++) if (stepIncluded(tour.steps[i], env)) after++
  const ordinal = before + 1
  return { ordinal, total: ordinal + after, first: before === 0, last: after === 0 }
}

export function marksSeen(reason: CloseReason): boolean {
  return reason !== 'route'
}

/** A re-opened Song / Score tour chains Live keys: it follows «Готово» only; «Пропустити» or Esc ends both. */
export function afterClose(queue: readonly TourId[], reason: CloseReason): { next: TourId | null; queue: TourId[] } {
  if (reason !== 'done' || !queue.length) return { next: null, queue: [] }
  return { next: queue[0], queue: queue.slice(1) }
}
