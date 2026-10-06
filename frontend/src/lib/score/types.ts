// Score model: quantized parts on the measures of lib/score/timeMap, ready for the MusicXML / MIDI
// writers. Times are ticks (DIV per quarter note = sixteenths) from the start of the first measure.

import type { KeySig, SpelledPitch } from './spelling'
import type { TimeMap } from './timeMap'

/** A note or chord of one voice, quantized. Voices never overlap: the gaps are rests. */
export interface ScoreNote {
  /** absolute ticks */
  start: number
  /** absolute ticks, > start */
  end: number
  /** MIDI notes (transposed), ascending, at least one */
  pitches: number[]
  /** how each pitch is written (same order) when the source knows (a chord's own spelling); else from the key */
  spelling?: SpelledPitch[]
  /** 0..1 */
  velocity: number
}

export type Clef = 'treble' | 'treble8vb' | 'bass'

export type NoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th'
export type BeamValue = 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook'

/** One written note / chord / rest of a measure (after splitting at bars, beats and chord changes). */
export interface WrittenNote {
  /** ticks from the start of the measure */
  start: number
  duration: number
  /** absent for a whole-measure rest */
  type: NoteType | null
  dots: number
  /** empty = rest */
  pitches: number[]
  /** the note's own spelling of the pitches (ScoreNote.spelling) */
  spelling?: SpelledPitch[]
  velocity: number
  /** a rest filling the whole measure */
  measureRest: boolean
  /** tied to the next written note (same pitches) */
  tieStart: boolean
  /** continues the previous written note */
  tieStop: boolean
  /** beam values by level (1 = eighths, 2 = sixteenths) */
  beams: BeamValue[]
  /** displayed chord symbol starting here ("N" = no chord) */
  harmony?: string
}

export interface Staff {
  clef: Clef
  events: ScoreNote[]
  /** written notes per measure (same length as the time map's measures) */
  measures: WrittenNote[][]
}

export type PartId = 'vocal' | 'piano'

export interface Part {
  id: PartId
  name: string
  abbreviation: string
  /** General MIDI program (0-based) */
  program: number
  staves: Staff[]
}

export interface ChordSymbol {
  /** absolute ticks */
  tick: number
  /** displayed label ("Bbm7/F"), "N" for no chord */
  label: string
}

export interface ScoreMeta {
  title: string
  artist: string | null
  /** displayed key name ("Am"), null when unknown */
  keyName: string | null
  /** BPM after the tempo correction, null when unknown */
  tempo: number | null
  /** "Транскрипція: Chords Listener" */
  credit: string
}

export interface Score {
  meta: ScoreMeta
  key: KeySig
  map: TimeMap
  parts: Part[]
  chords: ChordSymbol[]
  /** the part whose first staff carries the chord symbols */
  chordsOn: PartId | null
  /** which audio the piano part was transcribed from, or 'chords' (the simple level: built from the chord sheet) */
  pianoSource: 'instruments' | 'mix' | 'chords' | null
}

/**
 * How much of the transcription the piano part writes: 'full' = every transcribed note (sixteenths, up
 * to 4 notes per hand), 'medium' = an eighth grid and a thinner texture, 'simple' = only the chord
 * sheet's chords (the piano diagram's voicing + bass), no transcription needed. The vocals are on the
 * sixteenth grid at 'full', on the eighth grid otherwise.
 */
export type ScoreLevel = 'full' | 'medium' | 'simple'

export const SCORE_LEVELS: readonly ScoreLevel[] = ['full', 'medium', 'simple']

export interface ScoreOptions {
  /** show the vocal part (when vocal notes exist) */
  vocals: boolean
  /** show the piano part */
  piano: boolean
  /** chord symbols */
  chords: boolean
  /** notation level */
  level: ScoreLevel
}

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = { vocals: true, piano: true, chords: true, level: 'full' }
