// In-page job runner for browser mode: produces the same Job objects as the server (polled through
// lib/api.getJob), so the processing page, header pills and toasts work unchanged.
// Stages: queued → decoding → analyzing → done. One analysis at a time (it is CPU-heavy).
import { analyzeInBrowser, type BrowserAnalysis } from '../engine'
import type { ErrorCode, Job, JobStatus, TrackSource } from '../../types'
import { LocalError } from './errors'
import {
  contentId,
  deleteLocalTrack,
  displayName,
  hasLocalTrack,
  localAudio,
  localRecord,
  MAX_LOCAL_BYTES,
  MAX_LOCAL_DURATION_S,
  newRecord,
  replaceLocalAnalysis,
  saveNewLocalTrack,
} from './tracks'

export const LOCAL_JOB_PREFIX = 'local-job-'
const MAX_FINISHED = 30

/** Overall progress ranges, as in docs/SPEC.md (decoding 0.35–0.45, analyzing 0.45–1). */
const DECODE_START = 0.35
const ANALYZE_START = 0.45

const jobs = new Map<string, Job>()
/** track id → running job id (a second drop of the same file joins the running job) */
const activeByTrack = new Map<string, string>()
/** running / queued jobs that can be cancelled (their track was deleted) */
const controllers = new Map<string, AbortController>()
let queue: Promise<void> = Promise.resolve()

const deletedError = () => new LocalError('The track was deleted', 'not_found', 404)

export function isLocalJobId(id: string): boolean {
  return id.startsWith(LOCAL_JOB_PREFIX)
}

export function getLocalJob(id: string): Job | undefined {
  return jobs.get(id)
}

/** Jobs of this page session, newest first. */
export function listLocalJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function newJobId(): string {
  const rnd = globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? Math.random().toString(16).slice(2) + Date.now().toString(16)
  return LOCAL_JOB_PREFIX + rnd.slice(0, 16)
}

function put(job: Job): Job {
  jobs.set(job.id, job)
  if (jobs.size > MAX_FINISHED) {
    for (const [id, j] of jobs) {
      if (jobs.size <= MAX_FINISHED) break
      if (j.status === 'done' || j.status === 'error') jobs.delete(id)
    }
  }
  return job
}

function update(id: string, patch: Partial<Job>): void {
  const prev = jobs.get(id)
  if (prev) jobs.set(id, { ...prev, ...patch })
}

function createJob(fields: { title: string; source: TrackSource; status?: JobStatus; trackId?: string }): Job {
  const done = fields.status === 'done'
  return put({
    id: newJobId(),
    status: fields.status ?? 'queued',
    progress: done ? 1 : 0,
    message: done ? 'Already analyzed' : 'Queued',
    error: null,
    errorCode: null,
    trackId: fields.trackId ?? null,
    title: fields.title,
    thumbnail: null,
    source: fields.source,
    createdAt: new Date().toISOString(),
  })
}

/** Duration from the media element (cheap metadata read), or null when the browser cannot tell. */
function probeDuration(blob: Blob, timeoutMs = 5000): Promise<number | null> {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const el = new Audio()
    const finish = (value: number | null) => {
      clearTimeout(timer)
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    el.preload = 'metadata'
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
    el.onerror = () => finish(null)
    el.src = url
  })
}

const ENGINE_CODES: ReadonlySet<string> = new Set<ErrorCode>(['unsupported_format', 'too_long', 'too_large', 'analysis_failed'])

function failure(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof LocalError) return { code: err.code, message: err.message }
  // BrowserEngineError (lib/engine) carries an API error code already
  const coded = err as { code?: unknown; message?: unknown } | null
  if (coded && typeof coded.code === 'string' && ENGINE_CODES.has(coded.code))
    return { code: coded.code as ErrorCode, message: typeof coded.message === 'string' ? coded.message : coded.code }
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'EncodingError' || /decod|unsupported|codec|format/i.test(message))
    return { code: 'unsupported_format', message: message || 'The browser could not decode this file' }
  if (name === 'QuotaExceededError') return { code: 'too_large', message: 'Not enough browser storage for this file' }
  return { code: 'analysis_failed', message: message || 'Analysis failed' }
}

function checkAnalysis(a: BrowserAnalysis): BrowserAnalysis {
  if (!a || !Array.isArray(a.chords) || !a.chords.length || !(a.duration > 0))
    throw new LocalError('No chords were found in this recording', 'analysis_failed', 500)
  if (a.duration > MAX_LOCAL_DURATION_S)
    throw new LocalError(`The recording is longer than ${MAX_LOCAL_DURATION_S / 60} minutes`, 'too_long', 422)
  return a
}

type Saver = (analysis: BrowserAnalysis) => Promise<void>

function enqueue(jobId: string, trackId: string, audio: Blob, save: Saver): void {
  activeByTrack.set(trackId, jobId)
  const ctrl = new AbortController()
  controllers.set(jobId, ctrl)
  queue = queue.then(async () => {
    try {
      if (ctrl.signal.aborted) throw deletedError()
      update(jobId, { status: 'decoding', progress: DECODE_START, message: 'Decoding audio' })
      let analyzing = false
      let last = DECODE_START
      const analysis = await analyzeInBrowser(audio, (fraction, message) => {
        const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
        if (!analyzing && (f >= 0.1 || !/decod|load|read/i.test(message))) analyzing = true
        const overall = DECODE_START + (1 - DECODE_START) * f
        const progress = analyzing ? Math.max(ANALYZE_START, overall) : Math.min(ANALYZE_START - 0.001, overall)
        last = Math.min(0.99, Math.max(last, progress))
        if (ctrl.signal.aborted) return
        update(jobId, { status: analyzing ? 'analyzing' : 'decoding', progress: last, message: message || 'Analyzing' })
      }, { signal: ctrl.signal })
      if (ctrl.signal.aborted) throw deletedError()
      update(jobId, { status: 'analyzing', progress: Math.max(last, 0.99), message: 'Saving' })
      await save(checkAnalysis(analysis))
      if (ctrl.signal.aborted) {
        // deleted while saving: do not resurrect it
        await deleteLocalTrack(trackId).catch(() => undefined)
        throw deletedError()
      }
      update(jobId, { status: 'done', progress: 1, message: 'Done', trackId })
    } catch (err) {
      const { code, message } = ctrl.signal.aborted ? { code: 'not_found' as const, message: 'The track was deleted' } : failure(err)
      update(jobId, { status: 'error', errorCode: code, error: message, message: 'Failed' })
    } finally {
      controllers.delete(jobId)
      if (activeByTrack.get(trackId) === jobId) activeByTrack.delete(trackId)
    }
  })
}

/** The track is being deleted: stop its re-analysis (like the server's cancel_track_jobs). */
export function cancelLocalTrackJobs(trackId: string): void {
  const jobId = activeByTrack.get(trackId)
  if (!jobId) return
  controllers.get(jobId)?.abort()
  activeByTrack.delete(trackId)
}

export type LocalProgress = (fraction: number) => void

/**
 * Starts analyzing a dropped / picked / recorded file in the browser. Rejects (like the upload endpoint)
 * for files that are too large or too long; resolves with a job that is already `done` when the same file
 * was analyzed before.
 */
export async function startLocalUpload(file: File, onProgress?: LocalProgress, signal?: AbortSignal): Promise<Job> {
  const aborted = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  }
  if (file.size > MAX_LOCAL_BYTES)
    throw new LocalError(`The file is larger than ${MAX_LOCAL_BYTES / 1024 / 1024} MB`, 'too_large', 413)
  if (!file.size) throw new LocalError('The file is empty', 'unsupported_format', 415)
  onProgress?.(0.05)
  const trackId = await contentId(file)
  aborted()
  onProgress?.(0.6)
  const source: TrackSource = { type: 'file', url: null, videoId: null, filename: file.name || null }
  const title = displayName(file.name || 'Untitled')

  const running = activeByTrack.get(trackId)
  if (running && jobs.has(running)) {
    onProgress?.(1)
    return jobs.get(running) as Job
  }
  if (await hasLocalTrack(trackId)) {
    onProgress?.(1)
    return createJob({ title, source, status: 'done', trackId })
  }
  const duration = await probeDuration(file)
  aborted()
  if (duration !== null && duration > MAX_LOCAL_DURATION_S)
    throw new LocalError(`The recording is longer than ${MAX_LOCAL_DURATION_S / 60} minutes`, 'too_long', 422)

  const job = createJob({ title, source })
  enqueue(job.id, trackId, file, (analysis) =>
    saveNewLocalTrack(
      newRecord(trackId, { filename: file.name || title, mime: file.type, size: file.size, source }, analysis),
      file,
    ),
  )
  onProgress?.(1)
  return job
}

/** Runs the analysis again on the stored audio of a browser track (edits are dropped, like on the server). */
export async function startLocalReanalysis(trackId: string): Promise<Job> {
  const running = activeByTrack.get(trackId)
  if (running && jobs.has(running)) return jobs.get(running) as Job
  const rec = await localRecord(trackId)
  const audio = await localAudio(trackId)
  const job = createJob({ title: rec.title, source: rec.source })
  enqueue(job.id, trackId, audio, (analysis) => replaceLocalAnalysis(trackId, analysis))
  return job
}
