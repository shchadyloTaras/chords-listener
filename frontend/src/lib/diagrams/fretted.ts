// Shapes for every fretted instrument: chords-db for the guitar / ukulele, generated for the bass.

import type { ParsedChord } from '../music/chord'
import { bassVoicings } from './bass'
import { lookupVoicings, type ChordDb, type FretInstrument, type VoicingLookup } from './chordsDb'

/** The shapes a fretboard diagram shows; null while a chords-db instrument's shapes still load. */
export function fretVoicings(instrument: FretInstrument, chord: ParsedChord, db: ChordDb | null): VoicingLookup | null {
  if (instrument === 'bass') return bassVoicings(chord)
  return db ? lookupVoicings(db, instrument, chord) : null
}
