// Track data → Score: measures from the chord sheet's bars, the sung melody (VocalNotes) as the
// "Вокал" part, the instrument notes (TrackNotes) as the "Фортепіано" grand staff — or, at the simple
// level, the displayed chords as the piano diagram writes them — chord symbols from the displayed
// chords, key signature from the transposed key.

import type { KeyInfo } from '../../types'
import type { Bar } from '../music/bars'
import type { NoteArrays } from '../transcription/compact'
import { chordSymbolsFromBars } from './chordSymbols'
import { notate } from './notation'
import { arrangePiano, chordPiano, type PianoHands } from './piano'
import { keySignature } from './spelling'
import { buildTimeMap, DIV } from './timeMap'
import type { Part, Score, ScoreOptions, Staff } from './types'
import { medianPitch, quantizeVocal, type NoteRow } from './vocal'

export interface ScoreLabels {
  vocal: string
  vocalAbbr: string
  piano: string
  pianoAbbr: string
  /** "Транскрипція: Chords Listener" */
  credit: string
}

export interface ScoreInput {
  title: string
  artist?: string | null
  key: Pick<KeyInfo, 'tonic' | 'mode' | 'name'> | null | undefined
  /** displayed (transposed) key name */
  keyName: string | null
  transpose: number
  /** the user's accidental preference */
  accidentals: 'auto' | 'sharp' | 'flat'
  /** BPM after the tempo correction */
  tempo: number | null
  timeSignature: number
  /** the chord sheet's bars (effective rhythm) with their displayed chord slots */
  bars: readonly Pick<Bar, 'start' | 'end' | 'boundaries' | 'pickup' | 'slots'>[]
  /** instrument notes, null while not available (not needed at the simple level) */
  piano: readonly NoteRow[] | null
  pianoSource: 'instruments' | 'mix' | null
  /** sung notes, null while not available */
  vocals: readonly NoteRow[] | null
  options: ScoreOptions
  labels: ScoreLabels
}

/** Columnar notes (lib/transcription) as rows. */
export function rowsFromArrays(a: NoteArrays): NoteRow[] {
  const out: NoteRow[] = new Array(a.count)
  for (let i = 0; i < a.count; i++) out[i] = [a.start[i], a.end[i], a.midi[i], a.velocity[i]]
  return out
}

export function buildScore(input: ScoreInput): Score {
  const map = buildTimeMap(input.bars, input.timeSignature)
  const key = keySignature(input.key ?? null, input.transpose, input.accidentals)
  const { level } = input.options
  const full = level === 'full'
  const step = full ? 1 : 2
  const parts: Part[] = []

  // medium / simple: an eighth grid, and rests shorter than a quarter are closed (legato)
  const vocalEvents =
    input.vocals && input.options.vocals ? quantizeVocal(input.vocals, map, { step, transpose: input.transpose, minRest: full ? DIV / 2 : DIV }) : null
  if (vocalEvents) {
    const median = medianPitch(vocalEvents)
    parts.push({
      id: 'vocal',
      name: input.labels.vocal,
      abbreviation: input.labels.vocalAbbr,
      program: 53, // Voice Oohs
      staves: [{ clef: median !== null && median < 60 ? 'treble8vb' : 'treble', events: vocalEvents, measures: [] }],
    })
  }
  let hands: Pick<PianoHands, 'rh' | 'lh'> | null = null
  if (input.options.piano && level === 'simple') {
    const chords = chordPiano(input.bars, map.measures)
    // a sheet without chords has nothing to play
    if (chords.rh.length) hands = chords
  } else if (input.options.piano && input.piano) {
    hands = arrangePiano(input.piano, map, {
      step,
      transpose: input.transpose,
      simplified: level === 'medium',
      // a transcription of the full mix also hears the singer
      vocals: input.pianoSource === 'mix' ? input.vocals : null,
    })
  }
  if (hands) {
    parts.push({
      id: 'piano',
      name: input.labels.piano,
      abbreviation: input.labels.pianoAbbr,
      program: 0, // Acoustic Grand Piano
      staves: [
        { clef: 'treble', events: hands.rh, measures: [] },
        { clef: 'bass', events: hands.lh, measures: [] },
      ],
    })
  }

  const chords = input.options.chords && parts.length ? chordSymbolsFromBars(input.bars, map.measures) : []
  const chordsOn = chords.length ? parts[0].id : null
  const harmonies = new Map(chords.map((c) => [c.tick, c.label]))
  for (const part of parts) {
    part.staves.forEach((staff: Staff, i) => {
      staff.measures = notate(staff.events, map.measures, part.id === chordsOn && i === 0 ? harmonies : undefined)
    })
  }

  const tempo = input.tempo && input.tempo > 20 && input.tempo < 400 ? Math.round(input.tempo) : null
  return {
    meta: {
      title: input.title.trim() || '—',
      artist: input.artist?.trim() || null,
      keyName: input.keyName,
      tempo,
      credit: input.labels.credit,
    },
    key,
    map,
    parts,
    chords,
    chordsOn,
    pianoSource: parts.some((p) => p.id === 'piano') ? (level === 'simple' ? 'chords' : input.pianoSource) : null,
  }
}
