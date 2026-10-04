import { useEffect, useState } from 'react'
import { getLoadedDb, loadChordDb, type ChordDb, type FretInstrument } from '../../../lib/diagrams/chordsDb'

/** Loads the voicing DB for a fretted instrument (lazy chunk) and re-renders when it arrives. */
export function useChordDb(instrument: FretInstrument | null): ChordDb | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!instrument || getLoadedDb(instrument)) return
    let alive = true
    void loadChordDb(instrument).then(() => alive && setTick((n) => n + 1))
    return () => {
      alive = false
    }
  }, [instrument])
  return instrument ? getLoadedDb(instrument) : null
}
