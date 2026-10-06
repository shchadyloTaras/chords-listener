// The running tour (not persisted): which tour and step, the tour chained after it, the flags screens report
// and the blocks that hold auto-starts back. Actions wrap the pure step machine (lib/tour/machine.ts) with the
// page: anchors from the DOM, the song paused and following suspended on song pages, the seen flag.
import { create } from 'zustand'
import { parseHash } from '../../hooks/useRoute'
import {
  advance,
  afterClose,
  anchorsGone,
  goBack,
  marksSeen,
  startRun,
  type Advance,
  type CloseReason,
  type StepEnv,
  type TourRun,
} from '../../lib/tour/machine'
import { markTourSeen } from '../../lib/tour/storage'
import { TOURS, type Tour, type TourFlags, type TourId } from '../../lib/tour/tours'
import { reopenTours, tourRouteKey, type StartResult } from '../../lib/tour/trigger'
import { useApp } from '../../store'
import { useChordUi } from '../chords/uiStore'
import { anchorPresent, whenNoModal } from './dom'

export interface ActiveTour {
  tourId: TourId
  run: TourRun
  /** the screen it started on (trigger.ts tourRouteKey) */
  routeKey: string
  /** followPaused before the tour (song pages), restored on close; null elsewhere */
  followPaused: boolean | null
}

interface TourState {
  active: ActiveTour | null
  /** tours chained after the running one (a re-open: Song / Score → Live keys) */
  queue: TourId[]
  flags: TourFlags
  /** components holding auto-starts back (hooks.ts useTourBlock) */
  blocks: Record<string, true>
}

export const useTourStore = create<TourState>()(() => ({ active: null, queue: [], flags: {}, blocks: {} }))

export function tourEnv(): StepEnv {
  return { flags: useTourStore.getState().flags, present: anchorPresent }
}

const currentRoute = () => parseHash(window.location.hash)

export function startTour(tourId: TourId, queue: TourId[] = []): StartResult {
  if (useTourStore.getState().active) return 'busy'
  const run = startRun(TOURS[tourId], tourEnv())
  if (!run) return 'empty'
  const route = currentRoute()
  let followPaused: boolean | null = null
  // a song page: the song stops (and stays paused) and following waits; a recording keeps running
  if (route.name === 'track' || route.name === 'demo') {
    const app = useApp.getState()
    if (app.isPlaying) app.pause()
    const ui = useChordUi.getState()
    followPaused = ui.followPaused
    ui.setFollowPaused(true)
  }
  useTourStore.setState({ active: { tourId, run, routeKey: tourRouteKey(route), followPaused }, queue })
  return 'started'
}

export function closeTour(reason: CloseReason): void {
  const { active, queue } = useTourStore.getState()
  if (!active) return
  if (marksSeen(reason)) markTourSeen(active.tourId)
  if (active.followPaused !== null) useChordUi.getState().setFollowPaused(active.followPaused)
  const after = afterClose(queue, reason)
  useTourStore.setState({ active: null, queue: after.queue })
  if (after.next) startTour(after.next, after.queue)
}

function apply(step: (tour: Tour, run: TourRun, env: StepEnv) => Advance): void {
  const { active } = useTourStore.getState()
  if (!active) return
  const result = step(TOURS[active.tourId], active.run, tourEnv())
  if ('end' in result) closeTour(result.end)
  else useTourStore.setState({ active: { ...active, run: result.run } })
}

export function nextStep(): void {
  apply(advance)
}

/** TourHost: the step's anchors stayed missing for 300 ms. */
export function reportAnchorsGone(): void {
  apply(anchorsGone)
}

export function prevStep(): void {
  const { active } = useTourStore.getState()
  if (!active) return
  const run = goBack(TOURS[active.tourId], active.run, tourEnv())
  if (run) useTourStore.setState({ active: { ...active, run } })
}

/** Leaving the screen closes the tour at once without marking it seen, and drops the chained tours. */
export function closeIfRouteChanged(routeKey: string): void {
  const { active } = useTourStore.getState()
  if (active && active.routeKey !== routeKey) closeTour('route')
}

/** «Інструкція»: the current screen's tour (+ Live keys after «Готово» when its panel is on screen). */
export function startCurrentTour(opts: { afterModal?: boolean } = {}): void {
  const run = () => {
    const ids = reopenTours(currentRoute(), { view: useApp.getState().view, keysPanel: !!useTourStore.getState().flags.keysPanel })
    if (ids.length) startTour(ids[0], ids.slice(1))
  }
  if (opts.afterModal) whenNoModal(run)
  else run()
}
