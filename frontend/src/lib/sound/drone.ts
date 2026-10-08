// The harmonium's drone — what its drone stops (or a thumb held on Sa) do: one reed holding the
// song's tonic under everything played. Which key it holds, and the note looped while the song plays.

import type { KeyInfo } from '../../types'
import { HARMONIUM_LOW } from '../diagrams/harmonium'
import { keyTonicPc } from '../music/key'
import { mod12 } from '../music/notes'

/** The looped note is rendered with its key held this long (s)… */
export const DRONE_HOLD = 5
/** …and repeats between these times (s): after the reed has spoken, before the key comes up. */
export const DRONE_LOOP_START = 1
export const DRONE_LOOP_END = 4.6
/** Crossfade baked in before the loop end (s). */
export const DRONE_CROSSFADE = 0.3

/**
 * The drone's key: the song's tonic (after transposition) in the harmonium's lowest octave, C3–B3,
 * under the right hand. Null when the song's key is unknown.
 */
export function droneMidi(key: KeyInfo | null | undefined, transpose: number): number | null {
  const pc = keyTonicPc(key)
  return pc == null ? null : HARMONIUM_LOW + mod12(pc + transpose)
}

/**
 * A rendered note made loopable: cut at `end`, its last `fade` seconds crossfaded (equal power) into
 * the samples just before `start`, so jumping back from the loop end to the loop start continues
 * the sound without a click. Play it from 0 (the reed speaks once) looping over [start, end].
 */
export function droneLoop(
  x: Float32Array,
  sampleRate: number,
  start = DRONE_LOOP_START,
  end = DRONE_LOOP_END,
  fade = DRONE_CROSSFADE,
): Float32Array {
  const a = Math.round(start * sampleRate)
  const b = Math.min(Math.round(end * sampleRate), x.length)
  const f = Math.min(Math.round(fade * sampleRate), a, b - a)
  const y = x.slice(0, b)
  for (let i = 0; i < f; i++) {
    const t = ((i + 1) / f) * (Math.PI / 2)
    y[b - f + i] = x[b - f + i] * Math.cos(t) + x[a - f + i] * Math.sin(t)
  }
  return y
}
