// Everything the score needs for the loaded track: the instrument notes (transcribed in the page, from
// the instruments stem when the server separated one, else from the full mix), the sung notes
// (lib/vocals), and the chord model (bars, displayed chords, key, tempo) → Score → MusicXML.

import { useMemo } from 'react'
import { translate } from '../../../i18n'
import { buildScore, rowsFromArrays, type ScoreInput } from '../../../lib/score/build'
import { toMusicXml } from '../../../lib/score/musicxml'
import type { Score, ScoreOptions } from '../../../lib/score/types'
import type { NoteRow } from '../../../lib/score/vocal'
import {
  getNotesState,
  notesKey,
  requestNotes,
  retainNotes,
  releaseNotes,
  useNotesStore,
  type NotesSource,
  type NotesState,
} from '../../../lib/transcription'
import { fetchStem, loadVocals, stemsOf, useVocals, useVocalsStore, vocalsSupport, type VocalsState } from '../../../lib/vocals'
import { useApp, type Lang } from '../../../store'
import type { ChordModel } from '../model'
import { usePianoNotes } from './pianoNotes'
import { scoreOptions, useScoreSettings } from './scoreSettings'

/** Transcribed notes are in audio time; a recording linked to a video starts at `startOffset` (track time). */
function toTrackTime(rows: NoteRow[], offset: number): NoteRow[] {
  return offset ? rows.map(([s, e, m, v]) => [s + offset, e + offset, m, v] as NoteRow) : rows
}

function labels(lang: Lang) {
  return {
    vocal: translate(lang, 'score.part.vocal'),
    vocalAbbr: translate(lang, 'score.part.vocalAbbr'),
    piano: translate(lang, 'score.part.piano'),
    pianoAbbr: translate(lang, 'score.part.pianoAbbr'),
    credit: translate(lang, 'score.credit'),
  }
}

export function scoreInput(
  model: ChordModel,
  data: { piano: NoteRow[] | null; pianoSource: NotesSource | null; vocals: NoteRow[] | null },
  options: ScoreOptions,
  ctx: { lang: Lang; accidentals: ScoreInput['accidentals'] },
): ScoreInput {
  const { track, rhythm } = model
  return {
    title: track.title,
    artist: track.artist,
    key: track.key,
    keyName: model.keyName,
    transpose: model.transpose,
    accidentals: ctx.accidentals,
    tempo: rhythm.tempo,
    timeSignature: rhythm.timeSignature,
    bars: model.bars,
    piano: data.piano,
    pianoSource: data.pianoSource,
    vocals: data.vocals,
    options,
    labels: labels(ctx.lang),
  }
}

export interface ScoreData {
  piano: NotesState
  pianoSource: NotesSource
  vocals: VocalsState
  score: Score | null
  xml: string | null
  options: ScoreOptions
}

/** The score of the loaded track, rebuilt when the notes, the chords or the options change. */
export function useScoreData(model: ChordModel): ScoreData {
  const { track } = model
  const { notes: piano, source } = usePianoNotes(track)
  const vocals = useVocals(track)
  const settings = useScoreSettings()
  const options = useMemo(() => scoreOptions(settings), [settings])
  const lang = useApp((s) => s.lang)
  const accidentals = useApp((s) => s.accidentals)
  const offset = track.startOffset ?? 0

  const pianoRows = useMemo(() => (piano.status === 'ready' ? toTrackTime(rowsFromArrays(piano.index.notes), offset) : null), [piano, offset])
  const vocalRows = useMemo(() => (vocals.status === 'ready' ? (vocals.notes.notes as NoteRow[]) : null), [vocals])

  const score = useMemo(() => {
    if (!pianoRows && !vocalRows) return null
    const s = buildScore(scoreInput(model, { piano: pianoRows, pianoSource: pianoRows ? source : null, vocals: vocalRows }, options, { lang, accidentals }))
    return s.parts.length ? s : null
  }, [model, pianoRows, vocalRows, source, options, lang, accidentals])
  const xml = useMemo(() => (score ? toMusicXml(score) : null), [score])
  return { piano, pianoSource: source, vocals, score, xml, options }
}

function waitForNotes(key: string, timeoutMs: number): Promise<NotesState> {
  return new Promise((resolve) => {
    const settled = (s: NotesState | undefined) => !!s && (s.status === 'ready' || s.status === 'error' || s.status === 'unavailable')
    const now = useNotesStore.getState().tracks[key]
    if (settled(now)) return resolve(now as NotesState)
    const timer = setTimeout(() => {
      unsub()
      resolve(useNotesStore.getState().tracks[key] ?? { status: 'idle' })
    }, timeoutMs)
    const unsub = useNotesStore.subscribe((s) => {
      const st = s.tracks[key]
      if (settled(st)) {
        clearTimeout(timer)
        unsub()
        resolve(st as NotesState)
      }
    })
  })
}

function waitForVocals(id: string, timeoutMs: number): Promise<VocalsState> {
  return new Promise((resolve) => {
    const settled = (s: VocalsState | undefined) => !!s && s.status !== 'idle' && s.status !== 'loading'
    const now = useVocalsStore.getState().tracks[id]
    if (settled(now)) return resolve(now as VocalsState)
    const timer = setTimeout(() => {
      unsub()
      resolve(useVocalsStore.getState().tracks[id] ?? { status: 'idle' })
    }, timeoutMs)
    const unsub = useVocalsStore.subscribe((s) => {
      const st = s.tracks[id]
      if (settled(st)) {
        clearTimeout(timer)
        unsub()
        resolve(st as VocalsState)
      }
    })
  })
}

/**
 * The score for an export started outside the score view: loads (or transcribes) the instrument
 * notes and loads the vocal notes if the server has them (never starts a vocal job).
 */
export async function prepareScore(model: ChordModel, onWaiting?: () => void): Promise<Score | null> {
  const { track } = model
  const app = useApp.getState()
  const options = scoreOptions(useScoreSettings.getState())
  const source: NotesSource = stemsOf(track).includes('instruments') ? 'instruments' : 'mix'
  const key = notesKey(track.id, source)

  let piano: NotesState | null = null
  if (options.piano) {
    piano = getNotesState(track.id, source)
    if (piano.status !== 'ready') {
      onWaiting?.()
      retainNotes(key)
      try {
        requestNotes({
          id: track.id,
          audioUrl: track.audioUrl,
          duration: track.duration,
          notesSource: source,
          loadAudio: source === 'instruments' ? (signal) => fetchStem(track, 'instruments', signal) : undefined,
        })
        piano = await waitForNotes(key, 15 * 60_000)
      } finally {
        releaseNotes(key)
      }
    }
  }
  let vocals: VocalsState | null = null
  if (options.vocals && vocalsSupport(track) === 'ok') {
    await loadVocals(track)
    vocals = await waitForVocals(track.id, 30_000)
  }
  const pianoRows = piano?.status === 'ready' ? toTrackTime(rowsFromArrays(piano.index.notes), track.startOffset ?? 0) : null
  const vocalRows = vocals?.status === 'ready' ? (vocals.notes.notes as NoteRow[]) : null
  if (!pianoRows && !vocalRows) return null
  const score = buildScore(
    scoreInput(model, { piano: pianoRows, pianoSource: pianoRows ? source : null, vocals: vocalRows }, options, {
      lang: app.lang,
      accidentals: app.accidentals,
    }),
  )
  return score.parts.length ? score : null
}
