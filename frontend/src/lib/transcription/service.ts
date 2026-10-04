// Notes of the loaded track for the live piano and the score: memory cache → saved notes (server
// notes.json or the browser's IndexedDB) → transcription in the page (worker), saved afterwards so it
// runs once per track. One transcription at a time; it stops when its track is no longer shown.
//
// Source: the full mix (default), or a separated stem — 'instruments' (bass + other, from the server's
// vocal separation, see lib/vocals) so the piano part does not contain the singer. Each source is
// cached on its own (stem notes stay on this device, lib/transcription/stemCache).
import { create } from 'zustand'
import { useEffect, useLayoutEffect, useRef } from 'react'
import * as api from '../api'
import { toApiError } from '../api'
import type { Track } from '../../types'
import { decodeForModel } from './audio'
import { decodeNotes, encodeNotes, NotesFormatError, type NoteArrays } from './compact'
import { NoteIndex } from './noteIndex'
import type { TfBackend, TranscribeStats } from './protocol'
import { createTranscriber, TranscriberError } from './runner'
import { useConnection } from '../serverMode'
import { getStemNotes, putStemNotes } from './stemCache'

/** Transcription engine + settings recorded with the saved notes. */
export const NOTES_ENGINE = 'basic-pitch 1.0.1 (tfjs 4.22; onset 0.5, frame 0.3, min 80 ms)'

/** Which audio the notes are transcribed from. */
export type NotesSource = 'mix' | 'instruments'

export type NotesErrorCode = 'server' | 'audio' | 'decode' | 'model' | 'failed'

export type NotesState =
  | { status: 'idle' }
  /** the track has no audio (the demo) */
  | { status: 'unavailable' }
  /** reading saved notes */
  | { status: 'loading' }
  | {
      status: 'computing'
      stage: 'audio' | 'decode' | 'model' | 'notes'
      /** overall 0..1 */
      progress: number
      /** notes found so far (estimate) */
      found: number
      backend: TfBackend | null
    }
  | { status: 'ready'; index: NoteIndex; engine: string; saved: boolean; stats: TranscribeStats | null; source: NotesSource }
  | { status: 'error'; code: NotesErrorCode; message: string }

type NotesTrack = Pick<Track, 'id' | 'audioUrl' | 'duration'> & {
  /** default 'mix' (the track's audio) */
  notesSource?: NotesSource
  /** loads the audio of a stem source */
  loadAudio?: (signal: AbortSignal) => Promise<Blob>
}

/** Store / cache key of a track's notes from one source (the mix keeps the plain track id). */
export function notesKey(id: string, source: NotesSource = 'mix'): string {
  return source === 'mix' ? id : `${id}#${source}`
}

/** Where stem notes are kept on this device: per server (track ids are per server) and track. */
function stemCacheKey(id: string, source: NotesSource): string {
  const origin = useConnection.getState().serverOrigin ?? (typeof location !== 'undefined' ? location.origin : '')
  return `${origin}|${id}|${source}`
}

const IDLE: NotesState = { status: 'idle' }
/** finished results kept in memory (per track id) */
const MAX_CACHED = 6
/** a hidden panel keeps its transcription running this long (quick toggles, re-mounts) */
const RELEASE_GRACE_MS = 2500

export const useNotesStore = create<{ tracks: Record<string, NotesState> }>(() => ({ tracks: {} }))

function getState(id: string): NotesState {
  return useNotesStore.getState().tracks[id] ?? IDLE
}

function setState(id: string, state: NotesState): void {
  const tracks = { ...useNotesStore.getState().tracks }
  delete tracks[id] // re-insert last: insertion order = recency for the cache
  tracks[id] = state
  const ready = Object.keys(tracks).filter((k) => tracks[k].status === 'ready')
  for (const k of ready.slice(0, Math.max(0, ready.length - MAX_CACHED))) if (k !== id) delete tracks[k]
  useNotesStore.setState({ tracks })
}

/** URL of the Basic Pitch model (public/models, works under any base path). */
export function modelUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}models/basic-pitch/model.json`, location.href).href
}

let current: { key: string; ctrl: AbortController } | null = null
const holders = new Map<string, number>()
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()

function stop(key: string): void {
  if (current?.key !== key) return
  current.ctrl.abort(new DOMException('Transcription stopped', 'AbortError'))
  current = null
  const st = getState(key)
  if (st.status === 'loading' || st.status === 'computing') setState(key, IDLE)
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
}

function failure(err: unknown): { code: NotesErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof TranscriberError) return { code: err.code === 'model' ? 'model' : 'failed', message }
  if (err instanceof NotesFormatError) return { code: 'failed', message }
  return { code: 'failed', message }
}

async function run(track: NotesTrack, force: boolean, signal: AbortSignal): Promise<void> {
  const { id } = track
  const source = track.notesSource ?? 'mix'
  const key = notesKey(id, source)
  const engine = source === 'mix' ? NOTES_ENGINE : `${NOTES_ENGINE}; ${source} stem`
  const ready = (arrays: NoteArrays, eng: string, saved: boolean, stats: TranscribeStats | null) =>
    setState(key, { status: 'ready', index: new NoteIndex(arrays), engine: eng, saved, stats, source })
  if (!force) {
    setState(key, { status: 'loading' })
    try {
      const saved = source === 'mix' ? await api.getTrackNotes(id, signal) : await getStemNotes(stemCacheKey(id, source))
      if (signal.aborted) return
      if (saved) {
        ready(decodeNotes(saved, track.duration), saved.engine, true, null)
        return
      }
    } catch (err) {
      if (isAbort(err, signal)) return
      // unreadable / invalid saved notes are recomputed; an unreachable server fails below with the audio
      if (!(err instanceof NotesFormatError)) console.warn('[live piano] could not read saved notes:', err)
    }
  }

  const progress = (stage: 'audio' | 'decode' | 'model' | 'notes', value: number, found = 0, backend: TfBackend | null = null) =>
    setState(key, { status: 'computing', stage, progress: value, found, backend })
  progress('audio', 0)
  // the worker loads TF.js and the model while the audio downloads and decodes
  const transcriber = createTranscriber(modelUrl(), signal)
  transcriber.catch(() => undefined)
  /** leaving early: let the worker go (it holds the model and GPU memory) */
  const release = () => void transcriber.then((t) => t.dispose(), () => undefined)

  let blob: Blob
  try {
    if (source !== 'mix' && !track.loadAudio) throw new Error(`no audio for the ${source} stem`)
    blob = source === 'mix' || !track.loadAudio ? await api.fetchTrackAudio(track, signal) : await track.loadAudio(signal)
  } catch (err) {
    release()
    if (isAbort(err, signal)) return
    const e = toApiError(err)
    if (e.code === 'aborted') return
    setState(key, { status: 'error', code: e.code === 'network' ? 'server' : 'audio', message: e.message })
    return
  }
  progress('decode', 0.04)
  let samples: Float32Array
  try {
    samples = (await decodeForModel(blob)).samples
  } catch (err) {
    release()
    if (isAbort(err, signal)) return
    setState(key, { status: 'error', code: 'decode', message: err instanceof Error ? err.message : String(err) })
    return
  }
  if (signal.aborted) {
    release()
    return
  }
  progress('model', 0.1)

  try {
    const t = await transcriber
    progress('model', 0.1, 0, t.backend)
    let result: Awaited<ReturnType<typeof t.run>>
    try {
      result = await t.run(samples, (f, found) => {
        if (!signal.aborted) progress('model', 0.1 + 0.86 * f, found, t.backend)
      })
    } finally {
      t.dispose()
    }
    if (signal.aborted) return
    progress('notes', 0.97, result.notes.length, t.backend)
    const data = encodeNotes(result.notes, engine)
    const arrays = decodeNotes(data)
    let saved = false
    try {
      if (source === 'mix') await api.saveTrackNotes(id, data)
      else await putStemNotes(stemCacheKey(id, source), data)
      saved = true
    } catch (err) {
      // keep them for this session; next time the transcription runs again
      console.warn('[live piano] could not save the notes:', err)
    }
    if (signal.aborted) return
    ready(arrays, engine, saved, result.stats)
  } catch (err) {
    if (isAbort(err, signal)) return
    console.warn('[live piano] transcription failed:', err)
    setState(key, { status: 'error', ...failure(err) })
  }
}

/**
 * Makes the track's notes available: from memory, from storage, or by transcribing the audio.
 * `force` transcribes again (and overwrites what is saved). A transcription of another track (or
 * source) stops.
 */
export function requestNotes(track: NotesTrack, opts: { force?: boolean } = {}): void {
  const key = notesKey(track.id, track.notesSource)
  const hasAudio = (track.notesSource ?? 'mix') === 'mix' ? !!track.audioUrl : !!track.loadAudio
  if (!hasAudio) {
    if (getState(key).status !== 'unavailable') setState(key, { status: 'unavailable' })
    return
  }
  const st = getState(key)
  if (!opts.force && (st.status === 'ready' || st.status === 'loading' || st.status === 'computing')) return
  if (current) stop(current.key)
  const ctrl = new AbortController()
  current = { key, ctrl }
  void run(track, Boolean(opts.force), ctrl.signal).finally(() => {
    if (current?.ctrl === ctrl) current = null
  })
}

/** A view shows this track's notes (keeps its transcription alive). `key` = notesKey(id, source). */
export function retainNotes(key: string): void {
  holders.set(key, (holders.get(key) ?? 0) + 1)
  const timer = releaseTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    releaseTimers.delete(key)
  }
}

/** The view is gone: stop its transcription shortly after unless another view takes it over. */
export function releaseNotes(key: string): void {
  const n = (holders.get(key) ?? 1) - 1
  if (n > 0) {
    holders.set(key, n)
    return
  }
  holders.delete(key)
  releaseTimers.set(
    key,
    setTimeout(() => {
      releaseTimers.delete(key)
      if (!holders.has(key)) stop(key)
    }, RELEASE_GRACE_MS),
  )
}

/** Current notes state of a track / source (non-hook). */
export function getNotesState(id: string, source: NotesSource = 'mix'): NotesState {
  return getState(notesKey(id, source))
}

/**
 * Notes state of a track for a component; starts loading / transcribing while mounted. A stem source
 * needs `loadAudio` (read once per request; the effect re-runs when the source changes).
 */
export function useTrackNotes(
  track: NotesTrack | null,
  opts: { source?: NotesSource; loadAudio?: (signal: AbortSignal) => Promise<Blob> } = {},
): NotesState {
  const id = track?.id ?? ''
  const audioUrl = track?.audioUrl ?? ''
  const duration = track?.duration ?? 0
  const source = opts.source ?? 'mix'
  const key = id ? notesKey(id, source) : ''
  const loadRef = useRef(opts.loadAudio)
  useLayoutEffect(() => {
    loadRef.current = opts.loadAudio
  })
  useEffect(() => {
    if (!id) return
    retainNotes(key)
    const loadAudio = loadRef.current
    requestNotes({ id, audioUrl, duration, notesSource: source, loadAudio: loadAudio ? (signal) => loadAudio(signal) : undefined })
    return () => releaseNotes(key)
  }, [id, key, audioUrl, duration, source])
  return useNotesStore((s) => (key ? (s.tracks[key] ?? IDLE) : IDLE))
}

/** Tests: forget everything. */
export function resetNotesService(): void {
  if (current) current.ctrl.abort()
  current = null
  holders.clear()
  releaseTimers.forEach((t) => clearTimeout(t))
  releaseTimers.clear()
  useNotesStore.setState({ tracks: {} })
}
