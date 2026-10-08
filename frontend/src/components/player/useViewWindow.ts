import { useMemo } from 'react'
import { viewWindow, type ViewWindow } from '../../lib/viewWindow'
import { useApp } from '../../store'
import type { Track } from '../../types'

/** The track's view window (lib/viewWindow), with the player's own duration once it knows it. */
export function useViewWindow(track: Track): ViewWindow {
  const live = useApp((s) => s.duration)
  return useMemo(() => viewWindow(track, live), [track, live])
}
