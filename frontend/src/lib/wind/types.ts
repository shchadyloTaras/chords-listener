// Wind instruments (the sopilka, the concert flute): how their fingering charts are described.

export type WindInstrument = 'sopilka' | 'flute'

/** How much of a hole / key the finger covers: open, half (half-holing, pinching), closed. */
export type Cover = 0 | 0.5 | 1

/** One hole or key as the fingering chart draws it, on the chart's own grid (a column `width` × `height`). */
export interface WindKey {
  id: string
  /** what a player calls it ("L1" = left index finger, "T" = thumb, "G#" = the G♯ key…) */
  label: string
  x: number
  y: number
  /** half-width / half-height of its shape */
  rx: number
  ry: number
  /** a finger hole (round, the finger covers it) or a key / lever the finger presses */
  kind: 'hole' | 'key'
  /** on the back of the instrument (the sopilka's thumb hole): drawn to the side */
  back?: boolean
}

export interface WindSpec {
  instrument: WindInstrument
  /** the chart's holes / keys, from the mouthpiece down */
  keys: readonly WindKey[]
  /** one fingering column on the chart's grid */
  width: number
  height: number
  /** where the left hand's fingers end and the right hand's begin (a thin line across the column) */
  handBreak: number
  /** what is drawn at the top of the body: the sopilka's window (its voicing slot), the flute's embouchure hole */
  head: 'window' | 'embouchure'
  /** the MIDI notes where the 2nd, 3rd… register begins: blown harder (overblown) from there up */
  registers: readonly number[]
  /**
   * Fingering of every playable note (sounding MIDI note → one character per key, in `keys` order:
   * "x" closed / pressed, "o" open, "h" half-covered); spaces are ignored.
   */
  fingerings: Readonly<Record<number, string>>
  /** an arpeggio starts on its first note's lowest pitch at or above this MIDI note */
  startLow: number
}

/** A note of a chord's arpeggio on a wind instrument, with its fingering. */
export interface WindNote {
  midi: number
  /** spelled like the chord (G B♭ D, not G A♯ D) */
  name: string
  octave: number
  /** the chord's root (or slash bass), or another chord tone */
  role: 'root' | 'bass' | 'tone'
  /** 1 = the fundamental register, 2 = overblown to the next one (blown harder), 3… */
  register: number
  cover: readonly Cover[]
}
