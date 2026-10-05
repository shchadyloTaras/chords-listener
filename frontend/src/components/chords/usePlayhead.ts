// Narrow playhead-derived hooks: components re-render only when the derived index changes.

import { useCallback } from 'react'
import { chordIndexAt } from '../../lib/music/display'
import { useClockValue } from './clock'

/** Position of the playhead among chords: index ≥ 0, -1 before the first chord, -2 after the last. */
export function useChordPos(chords: { start: number; end: number }[]): number {
  return useClockValue(
    useCallback(
      (t: number) => {
        const i = chordIndexAt(chords, t)
        if (i >= 0) return i
        return !chords.length || t < chords[0].start ? -1 : -2
      },
      [chords],
    ),
  )
}
