import { useEffect, useState } from 'react'
import { getLoadedDb, loadChordDb, type ChordDb, type DbInstrument } from '../../../lib/diagrams/chordsDb'

/** Loads the chords-db voicings for the guitar / ukulele (lazy chunk) and re-renders when it arrives. */
export function useChordDb(instrument: DbInstrument | null): ChordDb | null {
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
