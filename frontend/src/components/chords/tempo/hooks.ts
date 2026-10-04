// Small tempo hooks shared by the hero readout, the toolbar badge and the tempo popover.

import { useCallback, useEffect, useState } from 'react'
import { localTempo } from '../../../lib/tempo'
import { useClockValue } from '../clock'
import { TAP_SHOW_MS, useTap } from './tapStore'

/** Local tempo at the playhead, rounded to whole BPM (re-renders only when that number changes). */
export function useLocalBpm(beats: readonly number[]): number | null {
  return useClockValue(
    useCallback(
      (t: number) => {
        const v = localTempo(beats, t)
        return v == null ? null : Math.round(v)
      },
      [beats],
    ),
  )
}

/** True when the local tempo deviates from the global one by more than 3 %. */
export function differsNotably(local: number | null, global: number | null): local is number {
  return local != null && global != null && global > 0 && Math.abs(local - global) / global > 0.03
}

/** The latest tap series while it is fresh (shown for a few seconds after the last tap). */
export function useRecentTap(): { bpm: number | null; count: number } | null {
  const bpm = useTap((s) => s.bpm)
  const count = useTap((s) => s.count)
  const at = useTap((s) => s.at)
  const [expiredAt, setExpiredAt] = useState(0)
  useEffect(() => {
    if (!at) return
    const left = TAP_SHOW_MS - (performance.now() - at)
    const id = window.setTimeout(() => setExpiredAt(at), Math.max(0, left))
    return () => window.clearTimeout(id)
  }, [at])
  return at > 0 && expiredAt !== at ? { bpm, count } : null
}

/** "×½" / "×2" for display. */
export function factorLabel(f: number): string {
  return f === 0.5 ? '½' : String(f)
}
