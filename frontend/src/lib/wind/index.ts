import type { Instrument } from '../../store'
import { windArpeggio } from './arpeggio'
import { FLUTE } from './flute'
import { SOPILKA } from './sopilka'
import type { WindInstrument, WindNote, WindSpec } from './types'

export * from './types'
export { arpeggioClasses, MAX_ARPEGGIO, parseCover, windArpeggio, windRange, windRegister } from './arpeggio'
export { FLUTE } from './flute'
export { SOPILKA } from './sopilka'

export const WIND_SPECS: Record<WindInstrument, WindSpec> = { sopilka: SOPILKA, flute: FLUTE }

const cache = new Map<string, WindNote[]>()

/** The chord's arpeggio with fingerings on `instrument` (memoized: diagrams and the sound ask often). */
export function windChord(instrument: WindInstrument | Instrument, label: string): WindNote[] {
  if (instrument !== 'sopilka' && instrument !== 'flute') return []
  const key = `${instrument}:${label}`
  let notes = cache.get(key)
  if (!notes) {
    notes = windArpeggio(WIND_SPECS[instrument], label)
    if (cache.size > 400) cache.clear()
    cache.set(key, notes)
  }
  return notes
}
