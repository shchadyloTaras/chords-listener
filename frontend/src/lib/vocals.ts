// The sung melody of a server track (docs/CLOUD.md → Vocals):
//   GET  /api/tracks/{id}/vocals → VocalNotes (404 not_found: not transcribed yet)
//   POST /api/tracks/{id}/vocals → Job (kind 'vocals': Demucs separation, then melody tracking),
//        polled until done; 501 / code 'unavailable' when the server has no vocal transcription.
//   GET  /api/tracks/{id}/stems/{vocals|instruments} → the separated audio (mp3)
// Browser tracks (ids "local-…") and browser mode have no server to do this.
import { useEffect } from 'react'
import { create } from 'zustand'
import { useApp } from '../store'
import type { Job, Track, TrackNotes, VocalNotes } from '../types'
import { ApiError, apiFetch, apiRequest, fetchTrackAudio, getJob, listJobs, toApiError } from './api'
import { isLocalId } from './local'
import { useConnection } from './serverMode'
import { decodeNotes, NotesFormatError } from './transcription/compact'
import { NoteIndex } from './transcription/noteIndex'

export type StemName = 'vocals' | 'instruments'

/** Where a running vocals job is (from its progress message). */
export type VocalsStage = 'queued' | 'separate' | 'melody'

export type VocalsState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** not transcribed yet (can be started) */
  | { status: 'missing' }
  | { status: 'running'; jobId: string; stage: VocalsStage; progress: number }
  | { status: 'ready'; notes: VocalNotes; index: NoteIndex }
  /** 'browser': no server for this track (browser mode / a track kept in this browser); 'server': not installed there */
  | { status: 'unavailable'; reason: 'browser' | 'server' }
  | { status: 'error'; code: string; message: string; during: 'load' | 'job' }

type VocalsTrack = Pick<Track, 'id' | 'duration'> & Partial<Pick<Track, 'vocals' | 'stems'>>

const IDLE: VocalsState = { status: 'idle' }
/** How often a running vocals job is polled (tests shorten it). */
export const vocalsPolling = { ms: 800 }

interface VocalsStore {
  tracks: Record<string, VocalsState>
  /** stems known to exist (from the track, or a finished job) */
  stems: Record<string, StemName[]>
}

export const useVocalsStore = create<VocalsStore>(() => ({ tracks: {}, stems: {} }))

function getState(id: string): VocalsState {
  return useVocalsStore.getState().tracks[id] ?? IDLE
}

function setState(id: string, state: VocalsState): void {
  useVocalsStore.setState((s) => ({ tracks: { ...s.tracks, [id]: state } }))
}

/** Whether vocals can be transcribed for this track here: 'ok', or why not. */
export function vocalsSupport(track: Pick<Track, 'id'>): 'ok' | 'browser' | 'server' {
  if (isLocalId(track.id)) return 'browser'
  const conn = useConnection.getState()
  if (conn.status !== 'server') return 'browser'
  if (conn.health?.engine?.features?.vocals === false) return 'server'
  return 'ok'
}

/** The track's separated stems (from the track itself or a vocals job finished in this session). */
export function stemsOf(track: Pick<Track, 'id'> & Partial<Pick<Track, 'stems'>>): StemName[] {
  const known = new Set<StemName>(useVocalsStore.getState().stems[track.id] ?? [])
  for (const s of track.stems ?? []) if (s === 'vocals' || s === 'instruments') known.add(s)
  return [...known]
}

/** Hook form of stemsOf (re-renders when a job adds stems). */
export function useStems(track: (Pick<Track, 'id'> & Partial<Pick<Track, 'stems'>>) | null): StemName[] {
  const fromStore = useVocalsStore((s) => (track ? s.stems[track.id] : undefined))
  if (!track || isLocalId(track.id)) return []
  const known = new Set<StemName>(fromStore ?? [])
  for (const s of track.stems ?? []) if (s === 'vocals' || s === 'instruments') known.add(s)
  return [...known].sort()
}

/** Downloads a stem's audio: a signed URL from the track when the server gives one, else the API path. */
export async function fetchStem(track: Pick<Track, 'id'> & { stemUrls?: Partial<Record<StemName, string>> | null }, name: StemName, signal?: AbortSignal): Promise<Blob> {
  const signed = track.stemUrls?.[name]
  if (signed) return fetchTrackAudio({ id: track.id, audioUrl: signed }, signal)
  const res = await apiFetch(`/tracks/${encodeURIComponent(track.id)}/stems/${name}`, { signal })
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      /* not JSON */
    }
    throw new ApiError(`stem ${name}: ${detail}`, res.status === 404 ? 'not_found' : res.status === 401 ? 'unauthorized' : 'http', res.status)
  }
  return res.blob()
}

function validVocals(data: VocalNotes, duration: number): NoteIndex {
  // same row layout and limits as TrackNotes
  const asNotes: TrackNotes = { version: 1, engine: data.engine || 'vocals', notes: data.notes }
  return new NoteIndex(decodeNotes(asNotes, duration))
}

function stageOf(job: Job): VocalsStage {
  if (job.status === 'queued') return 'queued'
  const m = (job.message || '').toLowerCase()
  if (/melod|pitch|note|crepe/.test(m)) return 'melody'
  if (/separat|stem|demucs|decod|waiting/.test(m)) return 'separate'
  return job.progress >= 0.75 ? 'melody' : 'separate'
}

/** The loaded track learns about its new vocals / stems without reloading (and without resetting playback). */
function markTrack(id: string): void {
  useVocalsStore.setState((s) => ({ stems: { ...s.stems, [id]: ['instruments', 'vocals'] } }))
  const app = useApp.getState()
  if (app.track?.id === id) useApp.setState({ track: { ...app.track, vocals: true, stems: ['vocals', 'instruments'] } })
}

const loading = new Map<string, Promise<void>>()
const polling = new Set<string>()

async function fetchVocals(track: VocalsTrack): Promise<void> {
  const { id } = track
  try {
    const data = await apiRequest<VocalNotes>(`/tracks/${encodeURIComponent(id)}/vocals`, { cache: 'no-store' })
    setState(id, { status: 'ready', notes: data, index: validVocals(data, track.duration) })
    if (!track.vocals || !track.stems?.length) markTrack(id)
  } catch (err) {
    const e = toApiError(err)
    if (e.code === 'not_found') {
      // maybe it is being transcribed right now (another tab, or before a reload)
      const active = await activeJob(id)
      if (active) return watchJob(track, active)
      setState(id, { status: 'missing' })
    } else if (e.code === 'unavailable' || e.status === 501) setState(id, { status: 'unavailable', reason: 'server' })
    else if (err instanceof NotesFormatError) setState(id, { status: 'error', code: 'invalid', message: err.message, during: 'load' })
    else setState(id, { status: 'error', code: e.code, message: e.message, during: 'load' })
  }
}

async function activeJob(id: string): Promise<Job | null> {
  try {
    const jobs = await listJobs()
    return jobs.find((j) => j.kind === 'vocals' && j.trackId === id && j.status !== 'done' && j.status !== 'error') ?? null
  } catch {
    return null
  }
}

function watchJob(track: VocalsTrack, job: Job): void {
  const { id } = track
  setState(id, { status: 'running', jobId: job.id, stage: stageOf(job), progress: job.progress })
  if (polling.has(id)) return
  polling.add(id)
  const tick = async (current: Job): Promise<void> => {
    const st = getState(id)
    // someone reset / replaced the state: stop polling
    if (st.status !== 'running' || st.jobId !== current.id) {
      polling.delete(id)
      return
    }
    if (current.status === 'done') {
      polling.delete(id)
      setState(id, { status: 'loading' })
      markTrack(id)
      await fetchVocals({ ...track, vocals: true, stems: ['vocals', 'instruments'] })
      return
    }
    if (current.status === 'error') {
      polling.delete(id)
      if (current.errorCode === 'unavailable') setState(id, { status: 'unavailable', reason: 'server' })
      else setState(id, { status: 'error', code: current.errorCode ?? 'internal', message: current.error ?? '', during: 'job' })
      return
    }
    setState(id, { status: 'running', jobId: current.id, stage: stageOf(current), progress: current.progress })
    await new Promise((r) => setTimeout(r, vocalsPolling.ms))
    let next: Job
    try {
      next = await getJob(current.id)
    } catch (err) {
      const e = toApiError(err)
      if (e.code === 'not_found') {
        polling.delete(id)
        setState(id, { status: 'error', code: 'not_found', message: e.message, during: 'job' })
        return
      }
      // a hiccup: keep polling
      next = current
    }
    return tick(next)
  }
  void tick(job)
}

/** Loads the track's vocal notes (once; again with `force`). */
export function loadVocals(track: VocalsTrack, opts: { force?: boolean } = {}): Promise<void> {
  const support = vocalsSupport(track)
  if (support !== 'ok') {
    setState(track.id, { status: 'unavailable', reason: support })
    return Promise.resolve()
  }
  const st = getState(track.id)
  if (!opts.force && st.status !== 'idle' && !(st.status === 'unavailable' && st.reason === 'browser')) return Promise.resolve()
  const pending = loading.get(track.id)
  if (pending) return pending
  setState(track.id, { status: 'loading' })
  const p = fetchVocals(track).finally(() => loading.delete(track.id))
  loading.set(track.id, p)
  return p
}

/** Starts the vocal transcription on the server (separation + melody) and follows its progress. */
export async function startVocals(track: VocalsTrack): Promise<void> {
  const support = vocalsSupport(track)
  if (support !== 'ok') {
    setState(track.id, { status: 'unavailable', reason: support })
    return
  }
  setState(track.id, { status: 'running', jobId: '', stage: 'queued', progress: 0 })
  try {
    const job = await apiRequest<Job>(`/tracks/${encodeURIComponent(track.id)}/vocals`, { method: 'POST', body: '{}' })
    watchJob(track, job)
  } catch (err) {
    const e = toApiError(err)
    if (e.code === 'unavailable' || e.status === 501) setState(track.id, { status: 'unavailable', reason: 'server' })
    else setState(track.id, { status: 'error', code: e.code, message: e.message, during: 'job' })
  }
}

/**
 * Vocals state of a track for a component; loads the notes while mounted (never starts a job).
 * `knownOnly`: ask the server only when the track says it has vocals (views that merely show them).
 */
export function useVocals(track: VocalsTrack | null, opts: { knownOnly?: boolean } = {}): VocalsState {
  const id = track?.id ?? ''
  const duration = track?.duration ?? 0
  const has = !!track?.vocals
  const skip = !!opts.knownOnly && !has
  const status = useConnection((c) => c.status)
  useEffect(() => {
    if (!id || skip) return
    void loadVocals({ id, duration, vocals: has })
  }, [id, duration, has, skip, status])
  return useVocalsStore((s) => (id ? (s.tracks[id] ?? IDLE) : IDLE))
}

/** Tests: forget everything. */
export function resetVocals(): void {
  polling.clear()
  loading.clear()
  useVocalsStore.setState({ tracks: {}, stems: {} })
}
