// Notes of the loaded track for the live piano: memory cache → saved notes (server notes.json or the
// browser's IndexedDB) → transcription in the page (worker), saved afterwards so it runs once per track.
// One transcription at a time; it stops when its track is no longer shown.
import { create } from 'zustand'
import { useEffect } from 'react'
import * as api from '../api'
import { toApiError } from '../api'
import type { Track } from '../../types'
import { decodeForModel } from './audio'
import { decodeNotes, encodeNotes, NotesFormatError, type NoteArrays } from './compact'
import { NoteIndex } from './noteIndex'
import type { TfBackend, TranscribeStats } from './protocol'
import { createTranscriber, TranscriberError } from './runner'

/** Transcription engine + settings recorded with the saved notes. */
export const NOTES_ENGINE = 'basic-pitch 1.0.1 (tfjs 4.22; onset 0.5, frame 0.3, min 80 ms)'

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
  | { status: 'ready'; index: NoteIndex; engine: string; saved: boolean; stats: TranscribeStats | null }
  | { status: 'error'; code: NotesErrorCode; message: string }

type NotesTrack = Pick<Track, 'id' | 'audioUrl' | 'duration'>

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

let current: { id: string; ctrl: AbortController } | null = null
const holders = new Map<string, number>()
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()

function stop(id: string): void {
  if (current?.id !== id) return
  current.ctrl.abort(new DOMException('Transcription stopped', 'AbortError'))
  current = null
  const st = getState(id)
  if (st.status === 'loading' || st.status === 'computing') setState(id, IDLE)
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

function ready(id: string, arrays: NoteArrays, engine: string, saved: boolean, stats: TranscribeStats | null): void {
  setState(id, { status: 'ready', index: new NoteIndex(arrays), engine, saved, stats })
}

async function run(track: NotesTrack, force: boolean, signal: AbortSignal): Promise<void> {
  const { id } = track
  if (!force) {
    setState(id, { status: 'loading' })
    try {
      const saved = await api.getTrackNotes(id, signal)
      if (saved) {
        ready(id, decodeNotes(saved, track.duration), saved.engine, true, null)
        return
      }
    } catch (err) {
      if (isAbort(err, signal)) return
      // unreadable / invalid saved notes are recomputed; an unreachable server fails below with the audio
      if (!(err instanceof NotesFormatError)) console.warn('[live piano] could not read saved notes:', err)
    }
  }

  const progress = (stage: 'audio' | 'decode' | 'model' | 'notes', value: number, found = 0, backend: TfBackend | null = null) =>
    setState(id, { status: 'computing', stage, progress: value, found, backend })
  progress('audio', 0)
  // the worker loads TF.js and the model while the audio downloads and decodes
  const transcriber = createTranscriber(modelUrl(), signal)
  transcriber.catch(() => undefined)
  /** leaving early: let the worker go (it holds the model and GPU memory) */
  const release = () => void transcriber.then((t) => t.dispose(), () => undefined)

  let blob: Blob
  try {
    blob = await api.fetchTrackAudio(track, signal)
  } catch (err) {
    release()
    if (isAbort(err, signal)) return
    const e = toApiError(err)
    if (e.code === 'aborted') return
    setState(id, { status: 'error', code: e.code === 'network' ? 'server' : 'audio', message: e.message })
    return
  }
  progress('decode', 0.04)
  let samples: Float32Array
  try {
    samples = (await decodeForModel(blob)).samples
  } catch (err) {
    release()
    if (isAbort(err, signal)) return
    setState(id, { status: 'error', code: 'decode', message: err instanceof Error ? err.message : String(err) })
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
    const data = encodeNotes(result.notes, NOTES_ENGINE)
    const arrays = decodeNotes(data)
    let saved = false
    try {
      await api.saveTrackNotes(id, data)
      saved = true
    } catch (err) {
      // keep them for this session; next time the transcription runs again
      console.warn('[live piano] could not save the notes:', err)
    }
    if (signal.aborted) return
    ready(id, arrays, NOTES_ENGINE, saved, result.stats)
  } catch (err) {
    if (isAbort(err, signal)) return
    console.warn('[live piano] transcription failed:', err)
    setState(id, { status: 'error', ...failure(err) })
  }
}

/**
 * Makes the track's notes available: from memory, from storage, or by transcribing the audio.
 * `force` transcribes again (and overwrites what is saved). A transcription of another track stops.
 */
export function requestNotes(track: NotesTrack, opts: { force?: boolean } = {}): void {
  const { id } = track
  if (!track.audioUrl) {
    if (getState(id).status !== 'unavailable') setState(id, { status: 'unavailable' })
    return
  }
  const st = getState(id)
  if (!opts.force && (st.status === 'ready' || st.status === 'loading' || st.status === 'computing')) return
  if (current) stop(current.id)
  const ctrl = new AbortController()
  current = { id, ctrl }
  void run(track, Boolean(opts.force), ctrl.signal).finally(() => {
    if (current?.ctrl === ctrl) current = null
  })
}

/** A view shows this track's notes (keeps its transcription alive). */
export function retainNotes(id: string): void {
  holders.set(id, (holders.get(id) ?? 0) + 1)
  const timer = releaseTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    releaseTimers.delete(id)
  }
}

/** The view is gone: stop its transcription shortly after unless another view takes it over. */
export function releaseNotes(id: string): void {
  const n = (holders.get(id) ?? 1) - 1
  if (n > 0) {
    holders.set(id, n)
    return
  }
  holders.delete(id)
  releaseTimers.set(
    id,
    setTimeout(() => {
      releaseTimers.delete(id)
      if (!holders.has(id)) stop(id)
    }, RELEASE_GRACE_MS),
  )
}

/** Notes state of a track for a component; starts loading / transcribing while mounted. */
export function useTrackNotes(track: NotesTrack | null): NotesState {
  const id = track?.id ?? ''
  const audioUrl = track?.audioUrl ?? ''
  const duration = track?.duration ?? 0
  useEffect(() => {
    if (!id) return
    retainNotes(id)
    requestNotes({ id, audioUrl, duration })
    return () => releaseNotes(id)
  }, [id, audioUrl, duration])
  return useNotesStore((s) => (id ? (s.tracks[id] ?? IDLE) : IDLE))
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
