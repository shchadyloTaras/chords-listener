// The ONE place the per-track tempo correction is applied: the chord model builds its bars from
// useEffectiveRhythm(), so the sheet, bar counter, timeline ticks, loops and copy formats all
// follow the same corrected beat grid.

import { useMemo } from 'react'
import { effectiveRhythm, normalizeFactor, type EffectiveRhythm, type TempoFactor } from '../../../lib/tempo'
import { useApp } from '../../../store'
import type { Track } from '../../../types'

/** Correction factor chosen for a track (1 when never changed). */
export function useTempoFactor(trackId: string): TempoFactor {
  return useApp((s) => normalizeFactor(s.tempoFactors?.[trackId]))
}

export function getTempoFactor(trackId: string): TempoFactor {
  return normalizeFactor(useApp.getState().tempoFactors?.[trackId])
}

/** Stores the factor for a track; ×1 removes the entry so the persisted map stays small. */
export function setTempoFactor(trackId: string, factor: TempoFactor): void {
  const { tempoFactors, setSetting } = useApp.getState()
  const next = { ...(tempoFactors ?? {}) }
  if (factor === 1) delete next[trackId]
  else next[trackId] = factor
  setSetting('tempoFactors', next)
}

/** Beats / downbeats / tempo of the track after its tempo correction (memoized). */
export function useEffectiveRhythm(track: Track): EffectiveRhythm {
  const factor = useTempoFactor(track.id)
  return useMemo(
    () =>
      effectiveRhythm(
        {
          beats: track.beats,
          downbeats: track.downbeats,
          tempo: track.tempo,
          timeSignature: track.timeSignature,
          duration: track.duration,
        },
        factor,
      ),
    [track.beats, track.downbeats, track.tempo, track.timeSignature, track.duration, factor],
  )
}
