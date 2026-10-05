// The instruments the chord diagrams and the chord sound offer, in the order of the pickers and the
// I key, and what each kind of instrument gets.

import type { Instrument } from '../store'
import type { FretInstrument } from './diagrams/chordsDb'

export const INSTRUMENTS: readonly Instrument[] = ['guitar', 'bass', 'ukulele', 'piano', 'harmonium', 'handpan']

/** Keyboards: the piano diagram + staff and the live keys panel. */
export function isKeyboard(i: Instrument): i is 'piano' | 'harmonium' {
  return i === 'piano' || i === 'harmonium'
}

/** Fretted instruments: a fretboard chart with a voicing switcher. */
export function isFretted(i: Instrument): i is FretInstrument {
  return i === 'guitar' || i === 'bass' || i === 'ukulele'
}

/** What a key of a keyboard diagram sounds like: the harmonium when it is the instrument, else the piano. */
export function keyInstrument(i: Instrument | undefined): 'piano' | 'harmonium' {
  return i === 'harmonium' ? 'harmonium' : 'piano'
}
