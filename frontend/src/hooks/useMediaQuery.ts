import { useCallback, useSyncExternalStore } from 'react'
import { canCaptureTab, TOUCH_ONLY_QUERY } from '../lib/live/capture'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Fine pointer + hover: a desktop-like device (used for autofocus / hover-only UI). */
export function useIsDesktopPointer(): boolean {
  return useMediaQuery('(hover: hover) and (pointer: fine)')
}

/** Hook form of canListenInTab: "listen in the tab" works here (desktop Chromium, not a touch-only device). */
export function useCanListenInTab(): boolean {
  const touchOnly = useMediaQuery(TOUCH_ONLY_QUERY)
  return canCaptureTab() && !touchOnly
}
