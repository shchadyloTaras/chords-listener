// "Перенести в хмару": moves a track analyzed in this browser (IndexedDB) into the signed-in user's cloud
// library. The stored audio goes up through Firebase Storage, the cloud analyzes it, the user's artist and
// chord edits are carried over, and only then is the copy on this device removed. One track at a time
// (the cloud runs at most two jobs per user).
import { create } from 'zustand'
import { t } from '../../i18n'
import { errorText } from '../../components/jobs/errorText'
import { useApp } from '../../store'
import type { Job, TrackSource } from '../../types'
import * as api from '../api'
import { ApiError, toApiError, type ClientErrorCode } from '../api'
import { localAudio, localRecord } from '../local/tracks'
import { useConnection } from '../serverMode'
import { mediaFilename } from './storage'

export type TransferPhase = 'queued' | 'uploading' | 'analyzing' | 'error'

export interface TransferState {
  phase: TransferPhase
  /** 0..1 of the current phase */
  progress: number
  error?: ClientErrorCode
}

export const useTransfers = create<Record<string, TransferState>>()(() => ({}))

function set(id: string, state: TransferState | null) {
  useTransfers.setState((s) => {
    const next = { ...s }
    if (state) next[id] = state
    else delete next[id]
    return next
  }, true)
}

/** Listeners told when a transfer finished (the library refreshes). */
const doneListeners = new Set<() => void>()
export function onTransferDone(fn: () => void): () => void {
  doneListeners.add(fn)
  return () => {
    doneListeners.delete(fn)
  }
}

const POLL_MS = 1000
const ACTIVE = new Set(['queued', 'downloading', 'decoding', 'analyzing'])

async function waitForJob(job: Job, onProgress: (p: number) => void): Promise<Job> {
  let current = job
  while (ACTIVE.has(current.status)) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    try {
      current = await api.getJob(current.id)
      onProgress(current.progress)
    } catch (err) {
      const e = toApiError(err)
      if (e.code === 'not_found' || e.code === 'unauthorized') throw e
      // a network hiccup: keep waiting
    }
  }
  if (current.status !== 'done' || !current.trackId) throw new ApiError(current.error ?? 'Analysis failed', current.errorCode ?? 'analysis_failed')
  return current
}

async function run(localId: string): Promise<void> {
  const rec = await localRecord(localId)
  try {
    if (useConnection.getState().backend !== 'cloud') throw new ApiError('Sign in to use the cloud', 'unauthorized', 401)
    const audio = await localAudio(localId)
    const mime = rec.mime || audio.type || 'application/octet-stream'
    const file = new File([audio], rec.source.filename || mediaFilename(rec.title, mime), { type: mime })
    set(localId, { phase: 'uploading', progress: 0 })
    // a recording of a video keeps its link; its audio already starts at the video's 0:00 (no offset)
    const source: TrackSource | undefined = rec.source.type === 'youtube' ? rec.source : undefined
    const job = await api.uploadFile(file, (f) => set(localId, { phase: 'uploading', progress: f }), {
      meta: { title: rec.title, source },
    })
    set(localId, { phase: 'analyzing', progress: job.progress })
    const done = await waitForJob(job, (p) => set(localId, { phase: 'analyzing', progress: p }))
    const patch: api.TrackPatch = {}
    if (rec.artist) patch.artist = rec.artist
    if (rec.edits) patch.chords = rec.edits
    if (Object.keys(patch).length) await api.updateTrack(done.trackId as string, patch)
    await api.deleteTrack(localId).catch((err) => {
      if (toApiError(err).code !== 'not_found') throw err
    })
    set(localId, null)
    useApp.getState().toast(t('cloud.history.moved', { title: rec.title }), 'success')
    doneListeners.forEach((fn) => fn())
  } catch (err) {
    const e = toApiError(err)
    set(localId, { phase: 'error', progress: 0, error: e.code })
    useApp.getState().toast(t('cloud.history.moveFailed', { title: rec.title, reason: errorText(e.code) }), 'error')
  }
}

let queue: Promise<void> = Promise.resolve()

/** Queues a browser track for the cloud (no-op while it is already on its way). */
export function moveToCloud(localId: string): void {
  const now = useTransfers.getState()[localId]
  if (now && now.phase !== 'error') return
  set(localId, { phase: 'queued', progress: 0 })
  queue = queue.then(() => run(localId)).catch((err) => {
    set(localId, { phase: 'error', progress: 0, error: toApiError(err).code })
  })
}
