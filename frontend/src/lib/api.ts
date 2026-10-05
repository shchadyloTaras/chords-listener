// Typed client for the chord server (see docs/SPEC.md "HTTP API" and docs/CLOUD.md), mode-aware:
//  · server mode — same-origin "/api" (page served by the backend / Vite proxy), the cloud API for signed-in
//    users of the hosted site (every call but /health carries the Firebase ID token; uploads go through
//    Firebase Storage), or the user's own server at `serverUrl` (advanced). URLs a server returns (signed
//    media URLs in the cloud) are resolved against it;
//  · browser mode — no server: files and recordings are analyzed in the page (lib/local), tracks live in
//    IndexedDB. Ids starting with "local-" always belong to the browser library, in any mode.
import type { ChordSegment, ErrorCode, Health, Job, Track, TrackNotes, TrackSource, TrackSummary } from '../types'
import { getIdToken, requestSignIn, useAuth } from './auth'
import { forgetServerJob, rememberServerJob } from './cloud/activity'
import { StorageUploadError, uploadToStorage } from './cloud/storage'
import {
  cancelLocalTrackJobs,
  deleteLocalTrack,
  getLocalJob,
  getLocalNotes,
  getLocalTrack,
  isLocalId,
  listLocalJobs,
  listLocalTracks,
  localAudio,
  LocalError,
  patchLocalTrack,
  putLocalNotes,
  resetLocalTrack,
  startLocalReanalysis,
  startLocalUpload,
} from './local'
import {
  needsFetchUpload,
  noteServerTrouble,
  resolveServerUrl,
  SAME_ORIGIN_API,
  serverFetch,
  whenSettled,
  type ConnectionState,
} from './serverMode'

/** Backend error codes plus client-side failure modes. */
export type ClientErrorCode = ErrorCode | 'network' | 'aborted' | 'http' | 'server_required'

const SERVER_CODES: readonly ErrorCode[] = [
  'invalid_url',
  'download_failed',
  'unsupported_format',
  'too_long',
  'too_large',
  'analysis_failed',
  'not_found',
  'internal',
  'unauthorized',
  'quota_exceeded',
  'download_blocked',
  'unavailable',
]

function isServerCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (SERVER_CODES as readonly string[]).includes(v)
}

export class ApiError extends Error {
  readonly code: ClientErrorCode
  readonly status: number

  constructor(message: string, code: ClientErrorCode, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** Normalizes anything thrown by the client into an ApiError. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof LocalError) return new ApiError(err.message, err.code, err.status)
  if (err instanceof StorageUploadError) {
    const code: ClientErrorCode =
      err.code === 'aborted'
        ? 'aborted'
        : err.code === 'too_large'
          ? 'too_large'
          : err.code === 'unauthenticated'
            ? 'unauthorized'
            : err.code === 'network'
              ? 'network'
              : 'internal'
    return new ApiError(err.message, code)
  }
  if (err instanceof DOMException && err.name === 'AbortError') return new ApiError('Request aborted', 'aborted')
  return new ApiError(err instanceof Error ? err.message : String(err), 'network')
}

/** Same-origin API base (the page is served by the backend). The live base is `useConnection().apiBase`. */
export const API_BASE = SAME_ORIGIN_API

export interface JobOptions {
  separate?: boolean
}

export interface TrackPatch {
  title?: string
  artist?: string
  chords?: ChordSegment[]
}

/** What an upload is (beyond its bytes): a tab recording of a YouTube video keeps its link. */
export interface UploadMeta {
  title?: string
  source?: TrackSource
  /** video time (s) where the recording began; chord times are shifted by it to line up with the video */
  startOffset?: number
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  const status = res.status
  let detail = res.statusText || `HTTP ${status}`
  let code: ClientErrorCode | null = null
  let parsed = false
  try {
    const body: unknown = await res.json()
    parsed = true
    if (body && typeof body === 'object') {
      const b = body as { detail?: unknown; code?: unknown }
      if (typeof b.detail === 'string') detail = b.detail
      if (isServerCode(b.code)) code = b.code
    }
  } catch {
    /* non-JSON body */
  }
  if (!code) {
    // A dev proxy answers 5xx without a JSON body when the backend is not running.
    if (status === 502 || status === 503 || status === 504 || (status === 500 && !parsed)) code = 'network'
    else if (status === 401) code = 'unauthorized'
    else if (status === 429) code = 'quota_exceeded'
    else if (status === 404) code = 'not_found'
    else if (status === 413) code = 'too_large'
    else if (status >= 500) code = 'internal'
    else code = 'http'
  }
  return new ApiError(detail, code, status)
}

type ServerConn = ConnectionState & { apiBase: string }

/** The connected server (waits for the first probe); throws when there is none. */
async function serverConn(): Promise<ServerConn> {
  const conn = await whenSettled()
  if (conn.status === 'server' && conn.apiBase) return conn as ServerConn
  throw new ApiError('No chord server is reachable', 'network')
}

/** Runs a browser-library operation, reporting failures as ApiError. */
async function local<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw toApiError(err)
  }
}

// ------------------------------------------------------------------ cloud session

/** The cloud rejected a renewed session and a sign-in did not help: don't keep asking for a while. */
const PROMPT_PAUSE_MS = 60_000
let promptPausedUntil = 0

/** `Authorization` for the cloud: the Firebase ID token (cached, refreshed by Firebase before it expires). */
async function bearer(conn: ConnectionState, forceRefresh = false): Promise<string | null> {
  if (conn.backend !== 'cloud') return null
  try {
    const token = await getIdToken(forceRefresh)
    return token ? `Bearer ${token}` : null
  } catch {
    // Firebase unreachable: the server answers 401 and the user is asked to sign in again
    return null
  }
}

/**
 * A 401 from the cloud: renew the token once (it may just have expired), then ask the user to sign in
 * and try once more. `send(force)` repeats the request; returns the last response.
 */
async function withSessionRetry(
  conn: ConnectionState,
  first: Response,
  send: (forceRefresh: boolean) => Promise<Response>,
): Promise<Response> {
  if (first.status !== 401 || conn.backend !== 'cloud') return first
  let res = await send(true)
  if (res.status !== 401 || Date.now() < promptPausedUntil) return res
  if (!(await requestSignIn('expired'))) {
    promptPausedUntil = Date.now() + PROMPT_PAUSE_MS / 2
    return res
  }
  res = await send(false)
  if (res.status === 401) promptPausedUntil = Date.now() + PROMPT_PAUSE_MS
  return res
}

// ------------------------------------------------------------------ requests

async function fetchOnce(conn: ServerConn, path: string, init: RequestInit, forceRefresh: boolean): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  const auth = path === '/health' ? null : await bearer(conn, forceRefresh)
  if (auth) headers.set('Authorization', auth)
  try {
    return await serverFetch(conn.apiBase + path, { ...init, headers })
  } catch (err) {
    const e = toApiError(err)
    if (e.code === 'network') noteServerTrouble()
    throw e
  }
}

/** Sends a request to the active server (the cloud gets the user's ID token, see withSessionRetry). */
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const conn = await serverConn()
  const first = await fetchOnce(conn, path, init, false)
  return withSessionRetry(conn, first, async (force) => fetchOnce(force ? conn : await serverConn(), path, init, force))
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init)
  if (!res.ok) {
    const e = await errorFromResponse(res)
    if (e.code === 'network') noteServerTrouble()
    throw e
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** JSON request against the active chord server (for feature modules outside this file). */
export const apiRequest = request

/** Raw request against the active chord server, same session handling (binary downloads, e.g. stems). */
export const apiFetch = send

/** Server objects carry server-relative URLs (signed ones in the cloud); make them work from any page. */
function withServerUrls<T extends { thumbnail?: string | null; audioUrl?: string; stemUrls?: Record<string, string> | null }>(obj: T): T {
  const out = { ...obj }
  if (typeof out.thumbnail === 'string') out.thumbnail = resolveServerUrl(out.thumbnail)
  if (typeof out.audioUrl === 'string') out.audioUrl = resolveServerUrl(out.audioUrl)
  if (out.stemUrls && typeof out.stemUrls === 'object') {
    const stems: Record<string, string> = {}
    for (const [name, url] of Object.entries(out.stemUrls)) stems[name] = typeof url === 'string' ? resolveServerUrl(url) : url
    out.stemUrls = stems
  }
  return out
}

function serverJob(job: Job): Job {
  return withServerUrls(job)
}

/** A job just started on the server: remembered while it runs, so a reload knows to look for it (cloud/activity). */
function startedJob(job: Job): Job {
  if (job.status !== 'done' && job.status !== 'error') rememberServerJob(job.id)
  return serverJob(job)
}

const enc = encodeURIComponent

// ---------------------------------------------------------------- endpoints

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  return request('/health', { signal, cache: 'no-store' })
}

/** Links (YouTube & co.) need a server's downloader (the cloud, or the user's own server). */
export async function createJob(url: string, options?: JobOptions, signal?: AbortSignal): Promise<Job> {
  const conn = await whenSettled()
  if (conn.status !== 'server')
    throw new ApiError('Links need the cloud (sign in) or a Chords Listener server', 'server_required')
  const job = await request<Job>('/jobs', {
    method: 'POST',
    body: JSON.stringify(options ? { url, options } : { url }),
    signal,
  })
  return startedJob(job)
}

/** Body of POST /api/jobs/storage (docs/CLOUD.md "Uploads"). */
export function storageJobBody(path: string, meta: UploadMeta = {}, options?: JobOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { path }
  const title = meta.title?.trim()
  if (title) body.title = title.slice(0, 300)
  if (meta.source) body.source = meta.source
  if (meta.startOffset !== undefined && Number.isFinite(meta.startOffset) && meta.startOffset > 0)
    body.startOffset = Math.round(meta.startOffset * 1000) / 1000
  if (options) body.options = options
  return body
}

/** Analyzes a file the browser has put into Firebase Storage (cloud only). */
export async function createStorageJob(path: string, meta?: UploadMeta, opts: { options?: JobOptions; signal?: AbortSignal } = {}): Promise<Job> {
  const job = await request<Job>('/jobs/storage', {
    method: 'POST',
    body: JSON.stringify(storageJobBody(path, meta, opts.options)),
    signal: opts.signal,
  })
  return startedJob(job)
}

export async function listJobs(signal?: AbortSignal): Promise<Job[]> {
  const conn = await whenSettled()
  const browserJobs = listLocalJobs()
  if (conn.status !== 'server') return browserJobs
  const jobs = (await request<Job[]>('/jobs', { signal, cache: 'no-store' })).map(serverJob)
  return [...browserJobs, ...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  if (isLocalId(id)) {
    const job = getLocalJob(id)
    if (!job) throw new ApiError('Job not found', 'not_found', 404)
    return job
  }
  const job = await request<Job>(`/jobs/${enc(id)}`, { signal, cache: 'no-store' })
  if (job.status === 'done' || job.status === 'error') forgetServerJob(job.id)
  return serverJob(job)
}

/** Server / cloud library (when connected) plus the tracks analyzed in this browser, newest first. */
export async function listTracks(signal?: AbortSignal): Promise<TrackSummary[]> {
  const conn = await whenSettled()
  const browserTracks = await local(listLocalTracks)
  if (conn.status !== 'server') return browserTracks
  let serverTracks: TrackSummary[]
  try {
    serverTracks = (await request<TrackSummary[]>('/tracks', { signal, cache: 'no-store' })).map(withServerUrls)
  } catch (err) {
    const e = toApiError(err)
    // the server just went away: show what this browser has (the next probe switches modes)
    if (e.code === 'network' && browserTracks.length) return browserTracks
    throw e
  }
  return [...browserTracks, ...serverTracks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getTrack(id: string, signal?: AbortSignal): Promise<Track> {
  if (isLocalId(id)) return local(() => getLocalTrack(id))
  return withServerUrls(await request<Track>(`/tracks/${enc(id)}`, { signal }))
}

export async function updateTrack(id: string, patch: TrackPatch): Promise<Track> {
  if (isLocalId(id)) return local(() => patchLocalTrack(id, patch))
  return withServerUrls(await request<Track>(`/tracks/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }))
}

export async function resetTrack(id: string): Promise<Track> {
  if (isLocalId(id)) return local(() => resetLocalTrack(id))
  return withServerUrls(await request<Track>(`/tracks/${enc(id)}/reset`, { method: 'POST' }))
}

export async function reanalyzeTrack(id: string, options?: JobOptions): Promise<Job> {
  if (isLocalId(id)) return local(() => startLocalReanalysis(id))
  const job = await request<Job>(`/tracks/${enc(id)}/reanalyze`, {
    method: 'POST',
    body: JSON.stringify(options ? { options } : {}),
  })
  return startedJob(job)
}

/** `keepalive` lets a pending delete finish while the page unloads. */
export async function deleteTrack(id: string, opts: { keepalive?: boolean } = {}): Promise<void> {
  if (isLocalId(id)) {
    cancelLocalTrackJobs(id)
    return local(() => deleteLocalTrack(id))
  }
  return request(`/tracks/${enc(id)}`, { method: 'DELETE', keepalive: opts.keepalive })
}

// ---------------------------------------------------------------- live piano notes

/** The track's transcribed notes (live piano); null when they have not been computed yet. */
export async function getTrackNotes(id: string, signal?: AbortSignal): Promise<TrackNotes | null> {
  if (isLocalId(id)) return local(() => getLocalNotes(id))
  try {
    return await request<TrackNotes>(`/tracks/${enc(id)}/notes`, { signal, cache: 'no-store' })
  } catch (err) {
    const e = toApiError(err)
    if (e.code === 'not_found') return null
    throw e
  }
}

/** Stores (replaces) the track's transcribed notes, so they are computed only once. */
export async function saveTrackNotes(id: string, notes: TrackNotes): Promise<void> {
  if (isLocalId(id)) return local(() => putLocalNotes(id, notes))
  await request<unknown>(`/tracks/${enc(id)}/notes`, { method: 'PUT', body: JSON.stringify(notes) })
}

/** The whole audio file of a track, for analysis in the page (the stored Blob for browser tracks). */
export async function fetchTrackAudio(track: Pick<Track, 'id' | 'audioUrl'>, signal?: AbortSignal): Promise<Blob> {
  if (isLocalId(track.id)) return local(() => localAudio(track.id))
  if (!track.audioUrl) throw new ApiError('This track has no audio', 'not_found', 404)
  let res: Response
  try {
    // cloud media URLs are signed: no Authorization header needed (or wanted: it would force a preflight)
    res = await serverFetch(new URL(track.audioUrl, location.href).href, { signal })
  } catch (err) {
    const e = toApiError(err)
    if (e.code === 'network') noteServerTrouble()
    throw e
  }
  if (!res.ok) throw await errorFromResponse(res)
  try {
    return await res.blob()
  } catch (err) {
    throw toApiError(err)
  }
}

/** Playback URL of a server track (browser tracks get an object URL from getTrack; cloud tracks a signed one). */
export function trackAudioUrl(id: string): string {
  return resolveServerUrl(`${API_BASE}/tracks/${enc(id)}/audio`)
}

/**
 * Fallback for browsers that refuse to stream http://localhost media inside an https page while fetch()
 * to it works (seen in Safari): loads the whole file into a Blob URL. Null when not applicable / failed.
 * The caller owns the returned URL (URL.revokeObjectURL when done).
 */
export async function fetchAudioBlobUrl(url: string): Promise<string | null> {
  let target: URL
  try {
    target = new URL(url, location.href)
  } catch {
    return null
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.origin === location.origin) return null
  try {
    const res = await serverFetch(target.href, { cache: 'force-cache' })
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- uploads

export type UploadProgress = (fraction: number, loaded: number, total: number) => void

export interface UploadOptions {
  options?: JobOptions
  signal?: AbortSignal
  meta?: UploadMeta
  /** analyze in this browser even when a server is connected (e.g. the cloud's daily limit is reached) */
  inBrowser?: boolean
}

/** Cloud Run refuses bodies over 32 MiB: a multipart upload to the cloud is only a fallback for small files. */
export const CLOUD_MULTIPART_MAX_BYTES = 30 * 1024 * 1024

/**
 * Starts analysis of a media file and returns the created Job.
 * Cloud: Firebase Storage (resumable, progress) + POST /jobs/storage. Local server: multipart upload
 * (`file`), XHR for upload progress. Browser mode: analyzed in the page.
 */
export async function uploadFile(file: File, onProgress?: UploadProgress, opts: UploadOptions = {}): Promise<Job> {
  const { signal, meta } = opts
  if (signal?.aborted) throw new ApiError('Upload aborted', 'aborted')
  const conn = await whenSettled()
  if (opts.inBrowser || conn.status !== 'server' || !conn.apiBase) {
    return local(() =>
      startLocalUpload(file, (f) => onProgress?.(f, Math.round(f * file.size), file.size), signal, meta),
    )
  }
  if (conn.backend === 'cloud') return cloudUpload(conn as ServerConn, file, onProgress, opts)
  return multipartUpload(conn as ServerConn, file, onProgress, opts)
}

async function cloudUpload(conn: ServerConn, file: File, onProgress: UploadProgress | undefined, opts: UploadOptions): Promise<Job> {
  const { signal, meta, options } = opts
  const uid = useAuth.getState().user?.uid
  if (!uid) throw new ApiError('Sign in to use the cloud', 'unauthorized', 401)
  const total = file.size
  let path: string
  try {
    path = await uploadToStorage(file, {
      uid,
      signal,
      // the last percent is the job creation
      onProgress: (loaded) => onProgress?.(Math.min(0.99, total ? loaded / total : 0), loaded, total),
    })
  } catch (err) {
    const e = toApiError(err)
    if (e.code === 'aborted' || e.code === 'too_large' || file.size > CLOUD_MULTIPART_MAX_BYTES) throw e
    // Storage refused or is unreachable (rules, bucket): small files can still go straight to the API
    console.warn('[upload] Firebase Storage failed, falling back to a direct upload', err)
    return multipartUpload(conn, file, onProgress, opts)
  }
  const job = await createStorageJob(path, meta, { options, signal })
  onProgress?.(1, total, total)
  return job
}

function multipartForm(file: File, opts: UploadOptions): FormData {
  const form = new FormData()
  form.append('file', file, file.name)
  if (opts.options) form.append('options', JSON.stringify(opts.options))
  const { meta } = opts
  if (meta?.title) form.append('title', meta.title)
  if (meta?.source) form.append('source', JSON.stringify(meta.source))
  if (meta?.startOffset && meta.startOffset > 0) form.append('startOffset', String(meta.startOffset))
  return form
}

async function multipartUpload(conn: ServerConn, file: File, onProgress: UploadProgress | undefined, opts: UploadOptions): Promise<Job> {
  const { signal } = opts
  const url = `${conn.apiBase}/jobs/upload`

  if (needsFetchUpload(url)) {
    // XHR cannot carry the Local Network Access hint: plain fetch, without byte progress
    onProgress?.(0, 0, file.size)
    let res: Response
    try {
      res = await serverFetch(url, { method: 'POST', body: multipartForm(file, opts), headers: { Accept: 'application/json' }, signal })
    } catch (err) {
      throw toApiError(err)
    }
    if (!res.ok) throw await errorFromResponse(res)
    onProgress?.(1, file.size, file.size)
    return startedJob((await res.json()) as Job)
  }

  const once = async (forceRefresh: boolean) => xhrUpload(url, file, multipartForm(file, opts), await bearer(conn, forceRefresh), onProgress, signal)
  const res = await withSessionRetry(conn, await once(false), once)
  if (res.status >= 200 && res.status < 300) {
    try {
      const job = (await res.json()) as Job
      onProgress?.(1, file.size, file.size)
      return startedJob(job)
    } catch {
      throw new ApiError('Malformed server response', 'internal', res.status)
    }
  }
  throw await errorFromResponse(res).catch(() => new ApiError(res.statusText, 'http', res.status))
}

/** POSTs a form with XHR (for upload progress); resolves with the response, rejects on network errors / abort. */
function xhrUpload(
  url: string,
  file: File,
  form: FormData,
  authorization: string | null,
  onProgress: UploadProgress | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError('Upload aborted', 'aborted'))
    const xhr = new XMLHttpRequest()
    const onAbortSignal = () => xhr.abort()
    signal?.addEventListener('abort', onAbortSignal, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbortSignal)

    xhr.open('POST', url)
    xhr.setRequestHeader('Accept', 'application/json')
    if (authorization) xhr.setRequestHeader('Authorization', authorization)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (e) => {
      const total = e.lengthComputable ? e.total : file.size
      onProgress?.(total ? Math.min(0.99, e.loaded / total) : 0, e.loaded, total)
    }
    xhr.onload = () => {
      done()
      resolve(
        new Response(xhr.responseText || null, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: { 'Content-Type': xhr.getResponseHeader('Content-Type') ?? 'application/json' },
        }),
      )
    }
    xhr.onerror = () => {
      done()
      noteServerTrouble()
      reject(new ApiError('Network error', 'network'))
    }
    xhr.onabort = () => {
      done()
      reject(new ApiError('Upload aborted', 'aborted'))
    }
    xhr.send(form)
  })
}
