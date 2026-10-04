import { useCallback, useSyncExternalStore } from 'react'

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
