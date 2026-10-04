// Shared tap-tempo state: the T key, the Tap button in the tempo popover and the hero readout
// all see the same series.

import { create } from 'zustand'
import { TapTempo } from '../../../lib/tempo'

/** How long the hero keeps showing the tapped tempo after the last tap (ms). */
export const TAP_SHOW_MS = 4000

interface TapState {
  /** tapped BPM of the latest series (null until two taps) */
  bpm: number | null
  /** taps in the latest series */
  count: number
  /** performance.now() of the last tap (0 = never) */
  at: number
  /** short flash for the Tap button */
  seq: number
  tap(): void
  clear(): void
}

const tapper = new TapTempo({ resetAfter: 2000, maxTaps: 8 })

export const useTap = create<TapState>()((set, get) => ({
  bpm: null,
  count: 0,
  at: 0,
  seq: 0,
  tap: () => {
    const now = performance.now()
    const r = tapper.tap(now)
    set({ bpm: r.bpm, count: r.count, at: now, seq: get().seq + 1 })
  },
  clear: () => {
    tapper.reset()
    set({ bpm: null, count: 0, at: 0 })
  },
}))
