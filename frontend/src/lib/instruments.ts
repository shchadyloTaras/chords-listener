// The instruments the chord diagrams and the chord sound offer, in the order of the pickers and the
// I key, and what each kind of instrument gets.

import type { Instrument } from '../store'
import type { FretInstrument } from './diagrams/chordsDb'
import type { CapoInstrument } from './music/capo'

export const INSTRUMENTS: readonly Instrument[] = ['guitar', 'bass', 'ukulele', 'piano', 'harmonium', 'handpan']

/** Keyboards: a keyboard diagram (the piano's, the harmonium's) under the staff, and the live keys panel. */
export function isKeyboard(i: Instrument): i is 'piano' | 'harmonium' {
  return i === 'piano' || i === 'harmonium'
}

/** Fretted instruments: a fretboard chart with a voicing switcher. */
export function isFretted(i: Instrument): i is FretInstrument {
  return i === 'guitar' || i === 'bass' || i === 'ukulele'
}

/** Instruments a capo suggestion makes sense for. */
export function hasCapo(i: Instrument): i is CapoInstrument {
  return i === 'guitar' || i === 'ukulele'
}

/** The instrument after `i` in the I-key cycle. */
export function nextInstrument(i: Instrument): Instrument {
  return INSTRUMENTS[(INSTRUMENTS.indexOf(i) + 1) % INSTRUMENTS.length]
}

/** The instrument once the live keys are turned on: the chosen keyboard, else the piano. */
export function liveKeysInstrument(i: Instrument): Instrument {
  return isKeyboard(i) ? i : 'piano'
}
