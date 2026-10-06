// How screens talk to the tour: useTourTrigger (this screen's tour may start by itself once `ready`),
// useTourFlags (facts the step conditions read), useTourBlock (hold every auto-start back for now).
import { useEffect, useId } from 'react'
import type { Route } from '../../hooks/useRoute'
import { isTourSeen } from '../../lib/tour/storage'
import type { TourFlag, TourFlags, TourId } from '../../lib/tour/tours'
import { createAutoStart, gateOpen, guideAvailable } from '../../lib/tour/trigger'
import { useApp } from '../../store'
import { domBlockers } from './dom'
import { startTour, useTourStore } from './tourStore'

/** How often a pending auto-start looks at the page (dialogs, menus, focus change without React knowing). */
export const CHECK_MS = 250

/** The tour starts ~500 ms after `ready` and a quiet page, once per device, never while another runs. */
export function useTourTrigger(tourId: TourId, ready: boolean, recording = false): void {
  useEffect(() => {
    if (!ready || isTourSeen(tourId)) return
    const auto = createAutoStart(() => startTour(tourId))
    const check = () => {
      const tour = useTourStore.getState()
      auto.update(
        gateOpen({
          seen: isTourSeen(tourId),
          ready,
          running: tour.active !== null,
          blocked: Object.keys(tour.blocks).length > 0,
          playing: useApp.getState().isPlaying,
          recording,
          ...domBlockers(),
        }),
      )
    }
    check()
    const id = window.setInterval(check, CHECK_MS)
    return () => {
      window.clearInterval(id)
      auto.dispose()
    }
  }, [tourId, ready, recording])
}

/** Reports flags while the component is mounted; they are removed with it. */
export function useTourFlags(flags: TourFlags): void {
  const json = JSON.stringify(flags)
  useEffect(() => {
    const own = JSON.parse(json) as TourFlags
    useTourStore.setState((s) => ({ flags: { ...s.flags, ...own } }))
    return () =>
      useTourStore.setState((s) => {
        const flags = { ...s.flags }
        for (const key of Object.keys(own)) delete flags[key as TourFlag]
        return { flags }
      })
  }, [json])
}

/** While `blocked`, no tour starts by itself (a link on its way, a file uploading, text in the link field). */
export function useTourBlock(blocked: boolean): void {
  const id = useId()
  useEffect(() => {
    if (!blocked) return
    useTourStore.setState((s) => ({ blocks: { ...s.blocks, [id]: true } }))
    return () =>
      useTourStore.setState((s) => {
        const blocks = { ...s.blocks }
        delete blocks[id]
        return { blocks }
      })
  }, [id, blocked])
}

/** Whether the «Інструкція» entries show here (no tour on job / not-found; a song page only once loaded). */
export function useGuideAvailable(route: Route): boolean {
  const trackLoaded = useApp((s) => s.track !== null)
  return guideAvailable(route, trackLoaded)
}
