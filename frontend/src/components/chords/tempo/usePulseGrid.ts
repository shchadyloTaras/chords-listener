// Beat pulse grid for the loaded track (effective beats labelled with their place in the bar).

import { useMemo } from 'react'
import { buildPulseGrid, type PulseGrid } from '../../../lib/tempo'
import { useChordModel } from '../model'

export function usePulseGrid(): PulseGrid {
  const { rhythm, bars } = useChordModel()
  return useMemo(() => buildPulseGrid(rhythm.beats, bars, rhythm.timeSignature), [rhythm, bars])
}
