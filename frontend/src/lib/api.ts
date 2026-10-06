// Typed client for the chord server (see docs/SPEC.md "HTTP API" and docs/CLOUD.md), mode-aware:
//  · server mode — same-origin "/api" (page served by the backend / Vite proxy), the cloud API for signed-in
//    users of the hosted site (every call but /health carries the Firebase ID token; uploads go through
//    Firebase Storage), or the user's own server at `serverUrl` (advanced). URLs a server returns (signed
//    media URLs in the cloud) are resolved against it;
//  · browser mode — no server: files and recordings are analyzed in the page (lib/local), tracks live in
//    IndexedDB. Ids starting with "local-" always belong to the browser library, in any mode.
// The signed-in user's cloud library is read without waking the cloud API while the live library answers
// (docs/CLOUD.md "Library in Firestore"): the list from the Firestore index (lib/cloud/library), track data,
// notes and vocal notes from Storage (lib/cloud/files), each kept on the device (lib/cloud/cache) and used
// while its version and createdAt are the index's; the audio streams through download-token URLs (one that
// Storage refuses gets the track read once more, see healedTrack). Any gap — the index not there or failed, a
// file missing or unreadable — takes the API path below, as it was before the index:
// the list, opened tracks, their audio and notes are kept on the device and served from there for a while,
// kept in step with edits, deletes and finished jobs; a track deleted here never comes back from it
// (lib/cloud/deleted). Nothing is kept or read this way for a local server or a guest.
import type { ChordSegment, ErrorCode, Health, Job, Track, TrackNotes, TrackSource, TrackSummary } from '../types'
import { getIdToken, requestSignIn, useAuth } from './auth'
import { forgetServerJob, recentServerJobs, rememberServerJob } from './cloud/activity'
import * as cache from './cloud/cache'
import { deleteConfirmed, forgetDeleted, isDeleted, rememberDeleted, settleDeleted, withoutDeleted } from './cloud/deleted'
import { readJsonFile, readTrackFile, STORAGE_DOWNLOAD_ORIGIN, trackFromFile } from './cloud/files'
import { libraryReady, useLibrary } from './cloud/library'
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
  useConnection,
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

// ------------------------------------------------------------------ cloud library on this device

/**
 * The account whose cloud library this device keeps (lib/cloud/cache): the signed-in user while the API is the
 * cloud; null for a local server, browser mode and guests (nothing is kept for them).
 */
export function cloudCacheUid(conn: ConnectionState = useConnection.getState()): string | null {
  if (conn.status !== 'server' || conn.backend !== 'cloud') return null
  return useAuth.getState().user?.uid ?? null
}

/** `uid` (taken when a request went out) still owns what is kept here: an answer for another account is not. */
function stillKeeping(uid: string | null): uid is string {
  return !!uid && cloudCacheUid() === uid
}

/** Keeps a track the cloud just sent (for `uid`, see stillKeeping); returns it with URLs that work from the page. */
async function keepTrack(uid: string | null, track: Track): Promise<Track> {
  if (stillKeeping(uid)) await cache.saveTrack(uid, track)
  return withServerUrls(track)
}

/**
 * A job that is over made or changed a song on the server (analysis, re-analysis, vocals): its track's JSON is
 * asked again next time, and so is the list (it still shows meanwhile).
 */
async function noteFinishedJob(job: Job): Promise<void> {
  const uid = job.status === 'done' && job.trackId ? cloudCacheUid() : null
  if (!uid) return
  // a song deleted here and made again (the same file gets the same id) shows again
  forgetDeleted(uid, job.trackId as string)
  await cache.forgetTrack(uid, job.trackId as string, ['track', 'vocals'])
  await cache.markListStale(uid)
}

function byNewest(tracks: TrackSummary[]): TrackSummary[] {
  return tracks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ------------------------------------------------------------------ the live library (Firestore index + Storage)

/** How long a read waits for the live library's first answer before it takes the API path. */
export const LIBRARY_WAIT_MS = 3000
/** The live wait (tests shorten it). */
export const libraryWait = { ms: LIBRARY_WAIT_MS }

interface LiveLibrary {
  tracks: TrackSummary[]
  versions: Record<string, number>
}

/** Track `id` as the live library publishes it (what a copy kept here must match); undefined: not in the index. */
function publishedOf(live: LiveLibrary, id: string): cache.Published | undefined {
  const version = live.versions[id]
  const createdAt = live.tracks.find((t) => t.id === id)?.createdAt
  return version === undefined || createdAt === undefined ? undefined : { version, createdAt }
}

/** The live library as it answers for `uid` right now: followed for them, listed, no failure. Else null. */
function liveNow(uid: string): LiveLibrary | null {
  const s = useLibrary.getState()
  return s.uid === uid && libraryReady() && s.tracks ? { tracks: s.tracks, versions: s.versions } : null
}

/** The live library follows `uid`, its first answer still on its way. */
function liveStarting(uid: string): boolean {
  const s = useLibrary.getState()
  return s.uid === uid && s.tracks === null && !s.error
}

/**
 * The live library's state when its first answer did not come within libraryWait.ms (offline, Firestore
 * unreachable while the API is not): while it stays that state, reads take the API path at once instead of
 * waiting again each time. An answer, a failure, a stop or a new start (also another account) is a new state.
 */
let unanswered: object | null = null

/**
 * Resolves once the live library of `uid` has answered, failed or stopped — at the latest after libraryWait.ms,
 * at once when it did not answer in time before, or when `signal` aborts.
 */
function liveAnswered(uid: string, signal?: AbortSignal): Promise<void> {
  if (!liveStarting(uid) || useLibrary.getState() === unanswered || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(() => {
      unanswered = useLibrary.getState()
      done()
    }, libraryWait.ms)
    const unsubscribe = useLibrary.subscribe(() => {
      if (!liveStarting(uid)) done()
    })
    signal?.addEventListener('abort', done)
  })
}

/** The live library of `uid`, its first answer waited for when on its way. Null: the API path (TTLs, tombstones). */
async function liveLibrary(uid: string, signal?: AbortSignal): Promise<LiveLibrary | null> {
  await liveAnswered(uid, signal)
  return liveNow(uid)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApiError('Request aborted', 'aborted')
}

/**
 * The cloud list while the live library answers for `uid` (kept here for the next first paint). Its first answer
 * is waited for when on its way — the home page shows the list kept here meanwhile (listCachedTracks). Null: the
 * API path — the index failed or did not answer in time, and the list kept here is trusted for LIST_TTL_MS only.
 */
async function liveList(uid: string): Promise<TrackSummary[] | null> {
  await liveAnswered(uid)
  // Read after the last await and saved without waiting, so nothing comes between this read and the caller: a
  // list that changes while a refresh is in flight joins that refresh (tracksStore) and must not be missed.
  const live = liveNow(uid)
  if (!live) return null
  if (stillKeeping(uid)) void cache.saveLiveList(uid, live.tracks)
  return live.tracks.map(withServerUrls)
}

/**
 * A cloud track while the live library answers (`at`: the index's version and createdAt for it): the copy kept
 * here at that, else track.json from Storage (kept with its version), else the API. Not in the index — brand new
 * (not published yet) or deleted — the API says which.
 */
async function publishedTrack(uid: string, id: string, at: cache.Published | undefined, signal?: AbortSignal): Promise<Track> {
  if (!at) return askTrack(uid, id, signal)
  const kept = await cache.cachedTrackAt(uid, id, at)
  if (kept) return withServerUrls(kept)
  const file = await readTrackFile(uid, id).catch(() => null)
  throwIfAborted(signal)
  return file ? keepTrack(uid, trackFromFile(file)) : askTrack(uid, id, signal)
}

/**
 * Live-piano notes ('notes') or vocal notes ('vocals') of a cloud track while the live library answers for `uid`:
 * the copy kept here at the track's version and createdAt, else notes.json / vocals.json from Storage, else `ask`
 * (the API) — what is found is kept at those. Null: not computed yet; that is never kept, so notes saved later
 * (also on another device: PUT /notes leaves the version as it is) show on the next open. Undefined: the live
 * library does not answer for this track — the caller's API path.
 */
export async function publishedJson<T>(
  uid: string,
  kind: cache.JsonKind,
  id: string,
  ask: () => Promise<T | null>,
  signal?: AbortSignal,
): Promise<T | null | undefined> {
  const live = await liveLibrary(uid, signal)
  throwIfAborted(signal)
  const at = live ? publishedOf(live, id) : undefined
  if (!at) return undefined
  const kept = await cache.cachedJsonAt<T>(uid, kind, id, at)
  if (kept !== null) return kept
  let value: T | null
  try {
    value = await readJsonFile<T>(uid, id, `${kind}.json`)
  } catch {
    value = await ask()
  }
  if (value !== null && stillKeeping(uid)) await cache.saveJson(uid, kind, id, value, at)
  return value
}

// ------------------------------------------------------------------ token URLs Storage refuses

/** What each cloud track was healed to this session (healedTrack), for `uid`. */
let healing: { uid: string; tracks: Map<string, Promise<Track | null>> } = { uid: '', tracks: new Map() }

/** Tests: forget which tracks were healed this session. */
export function resetMediaHealing(): void {
  healing = { uid: '', tracks: new Map() }
}

const isStorageUrl = (href: string) => href.startsWith(`${STORAGE_DOWNLOAD_ORIGIN}/`)

/**
 * Storage refused `failedUrl`, a download-token URL of cloud track `id` (403/404): its objects were made again
 * with new tokens (the track deleted and added again, re-published without a new version) or a token was
 * revoked. What is kept of the track is forgotten and track.json read once more; when that brings nothing new
 * (missing, unreadable, or still `failedUrl`), the API's track. Once per track per session: every later refusal
 * (its audio, a stem, another open) gets this same answer, and nothing is read or asked again — no loops.
 * Null: nothing came of it.
 */
function healedTrack(uid: string, id: string, failedUrl: string): Promise<Track | null> {
  if (healing.uid !== uid) healing = { uid, tracks: new Map() }
  let healed = healing.tracks.get(id)
  if (!healed) {
    healed = heal(uid, id, failedUrl).catch(() => null)
    healing.tracks.set(id, healed)
  }
  return healed
}

async function heal(uid: string, id: string, failedUrl: string): Promise<Track | null> {
  await cache.forgetTrack(uid, id, ['track'])
  const file = await readTrackFile(uid, id).catch(() => null)
  const track = file ? trackFromFile(file) : null
  const urls = track ? [track.audioUrl, ...Object.values(track.stemUrls ?? {})] : []
  return track && !urls.includes(failedUrl) ? keepTrack(uid, track) : askTrack(uid, id)
}

/**
 * The response for `url`, a media file of cloud track `id` (its audio, or a stem: `pick` finds that file's URL
 * in a track). A download-token URL Storage refuses is tried once more, with the healed track's (healedTrack).
 */
async function trackMedia(
  uid: string | null,
  id: string,
  url: string,
  pick: (t: Track) => string | null | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await mediaResponse(url, signal)
  if (!uid || (res.status !== 403 && res.status !== 404) || !isStorageUrl(url)) return res
  const healed = await healedTrack(uid, id, url)
  throwIfAborted(signal)
  const next = healed ? pick(healed) : null
  return next && next !== url ? mediaResponse(next, signal) : res
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
  const raw = await request<Job[]>('/jobs', { signal, cache: 'no-store' })
  // jobs started here that ended while the page was closed (a re-analysis, vocals): their tracks changed
  const remembered = new Set(recentServerJobs())
  await Promise.all(raw.filter((j) => remembered.has(j.id)).map(noteFinishedJob))
  const jobs = raw.map(serverJob)
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
  // before anyone reacts to it (reloads the list, the vocals): what is kept of its track is already stale
  await noteFinishedJob(job)
  return serverJob(job)
}

/**
 * Server / cloud library (when connected) plus the tracks analyzed in this browser, newest first. The cloud's
 * list is the live library's while it answers (see liveList); else it comes from this device while younger
 * than LIST_TTL_MS (lib/cloud/cache), and `force` asks the cloud now.
 */
export async function listTracks(signal?: AbortSignal, opts: { force?: boolean } = {}): Promise<TrackSummary[]> {
  const conn = await whenSettled()
  const browserTracks = await local(listLocalTracks)
  if (conn.status !== 'server') return browserTracks
  const uid = cloudCacheUid(conn)
  const live = uid ? await liveList(uid) : null
  if (live) return byNewest([...browserTracks, ...live])
  const kept = uid ? await cache.cachedList(uid) : null
  const keptTracks = () => (uid && kept ? withoutDeleted(uid, kept.tracks).map(withServerUrls) : [])
  if (kept && !opts.force && cache.isFresh(kept.savedAt, cache.LIST_TTL_MS)) return byNewest([...browserTracks, ...keptTracks()])
  let serverTracks: TrackSummary[]
  try {
    const askedAt = Date.now()
    const raw = await request<TrackSummary[]>('/tracks', { signal, cache: 'no-store' })
    // an answer that set off before a delete here still lists the track
    const listed = uid ? settleDeleted(uid, raw, askedAt) : raw
    if (stillKeeping(uid)) await cache.saveList(uid, listed)
    serverTracks = listed.map(withServerUrls)
  } catch (err) {
    const e = toApiError(err)
    // the server just went away: show what this device has (the next probe switches modes)
    if (e.code === 'network' && kept) return byNewest([...browserTracks, ...keptTracks()])
    if (e.code === 'network' && browserTracks.length) return browserTracks
    throw e
  }
  return byNewest([...browserTracks, ...serverTracks])
}

/**
 * The library as this device last saw it, without asking anyone: the browser's tracks plus the cloud list —
 * the live library's when it answers, else the one kept here, whatever its age. Null when there is neither
 * (not the cloud, or never listed).
 */
export async function listCachedTracks(): Promise<TrackSummary[] | null> {
  const uid = cloudCacheUid(await whenSettled())
  if (!uid) return null
  const kept = liveNow(uid) ? null : await cache.cachedList(uid)
  if (!kept && !liveNow(uid)) return null
  const browserTracks = await local(listLocalTracks).catch(() => [])
  const cloudTracks = liveNow(uid)?.tracks ?? withoutDeleted(uid, kept?.tracks ?? [])
  return byNewest([...browserTracks, ...cloudTracks.map(withServerUrls)])
}

/**
 * A cloud track. While the live library answers, the version decides (see publishedTrack); else one opened in
 * the last TRACK_TTL_MS comes from this device (lib/cloud/cache) — unless it was deleted here: then the cloud
 * says whether it is gone.
 */
export async function getTrack(id: string, signal?: AbortSignal): Promise<Track> {
  if (isLocalId(id)) return local(() => getLocalTrack(id))
  const uid = cloudCacheUid(await whenSettled())
  const live = uid ? await liveLibrary(uid, signal) : null
  throwIfAborted(signal)
  if (uid && live) return publishedTrack(uid, id, publishedOf(live, id), signal)
  const kept = uid && !isDeleted(uid, id) ? await cache.cachedTrack(uid, id) : null
  if (kept) return withServerUrls(kept)
  return askTrack(uid, id, signal)
}

/** GET /tracks/{id}, kept here; a track the cloud no longer has is forgotten here. */
async function askTrack(uid: string | null, id: string, signal?: AbortSignal): Promise<Track> {
  try {
    return await keepTrack(uid, await request<Track>(`/tracks/${enc(id)}`, { signal }))
  } catch (err) {
    // gone (deleted here or on another device): nothing of it stays on this device, its list entry neither
    if (uid && toApiError(err).code === 'not_found') {
      deleteConfirmed(uid, id)
      await cache.forgetTrack(uid, id)
    }
    throw err
  }
}

export async function updateTrack(id: string, patch: TrackPatch): Promise<Track> {
  if (isLocalId(id)) return local(() => patchLocalTrack(id, patch))
  const uid = cloudCacheUid()
  return keepTrack(uid, await request<Track>(`/tracks/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }))
}

export async function resetTrack(id: string): Promise<Track> {
  if (isLocalId(id)) return local(() => resetLocalTrack(id))
  const uid = cloudCacheUid()
  return keepTrack(uid, await request<Track>(`/tracks/${enc(id)}/reset`, { method: 'POST' }))
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
  const uid = cloudCacheUid()
  // before anything is awaited: the page may be gone before IndexedDB or the answer gets a word in
  if (uid) rememberDeleted(uid, id)
  // the page is going away (the answer may never be read): forget it here right now
  const forgotten = uid && opts.keepalive ? cache.forgetTrack(uid, id) : null
  try {
    await request(`/tracks/${enc(id)}`, { method: 'DELETE', keepalive: opts.keepalive })
  } catch (err) {
    if (uid && toApiError(err).code === 'not_found') {
      deleteConfirmed(uid, id)
      await cache.forgetTrack(uid, id)
    } else if (uid) {
      // not deleted: it shows again (the caller says the delete failed)
      forgetDeleted(uid, id)
    }
    throw err
  }
  if (!uid) return
  deleteConfirmed(uid, id)
  await (forgotten ?? cache.forgetTrack(uid, id))
}

// ---------------------------------------------------------------- live piano notes

/**
 * The track's transcribed notes (live piano); null when they have not been computed yet. A cloud track's come
 * from Storage while the live library answers (see publishedJson).
 */
export async function getTrackNotes(id: string, signal?: AbortSignal): Promise<TrackNotes | null> {
  if (isLocalId(id)) return local(() => getLocalNotes(id))
  const uid = cloudCacheUid(await whenSettled())
  const ask = async (): Promise<TrackNotes | null> => {
    try {
      return await request<TrackNotes>(`/tracks/${enc(id)}/notes`, { signal, cache: 'no-store' })
    } catch (err) {
      const e = toApiError(err)
      if (e.code === 'not_found') return null
      throw e
    }
  }
  const published = uid ? await publishedJson(uid, 'notes', id, ask, signal) : undefined
  if (published !== undefined) return published
  const kept = uid ? await cache.cachedJson<TrackNotes>(uid, 'notes', id) : null
  if (kept) return kept
  const notes = await ask()
  if (notes && stillKeeping(uid)) await cache.saveJson(uid, 'notes', id, notes)
  return notes
}

/** Stores (replaces) the track's transcribed notes, so they are computed only once. */
export async function saveTrackNotes(id: string, notes: TrackNotes): Promise<void> {
  if (isLocalId(id)) return local(() => putLocalNotes(id, notes))
  const uid = cloudCacheUid()
  await request<unknown>(`/tracks/${enc(id)}/notes`, { method: 'PUT', body: JSON.stringify(notes) })
  // PUT /notes leaves the track's version as it is: kept at the live library's, they stay valid
  if (!stillKeeping(uid)) return
  const live = liveNow(uid)
  await cache.saveJson(uid, 'notes', id, notes, live ? publishedOf(live, id) : undefined)
}

async function mediaResponse(url: string, signal?: AbortSignal): Promise<Response> {
  let href = url
  try {
    href = new URL(url, location.href).href
    // cloud media URLs are signed or carry a download token: no Authorization header needed (or wanted: it
    // would force a preflight)
    return await serverFetch(href, { signal })
  } catch (err) {
    const e = toApiError(err)
    // Storage unreachable (offline, no CORS) says nothing about the API server: asking it would wake the cloud
    if (e.code === 'network' && !isStorageUrl(href)) noteServerTrouble()
    throw e
  }
}

async function mediaBlob(res: Response): Promise<Blob> {
  if (!res.ok) throw await errorFromResponse(res)
  try {
    return await res.blob()
  } catch (err) {
    throw toApiError(err)
  }
}

/**
 * A media file of a server (e.g. a cloud stem by its signed URL), downloaded whole and not kept. `stemOf`: the
 * track and stem it is — a download-token URL Storage refuses is then healed (see trackMedia).
 */
export async function fetchMedia(url: string, signal?: AbortSignal, stemOf?: { trackId: string; stem: string }): Promise<Blob> {
  if (!stemOf) return mediaBlob(await mediaResponse(url, signal))
  return mediaBlob(await trackMedia(cloudCacheUid(), stemOf.trackId, url, (t) => t.stemUrls?.[stemOf.stem], signal))
}

/**
 * The whole audio file of a track, for analysis in the page (the stored Blob for browser tracks). A cloud track's
 * comes from this device when kept there, and what is downloaded is kept (lib/cloud/cache). A signed URL the cloud
 * refuses (401: it ran out) gets the track asked again once, for a fresh one; a token URL Storage refuses, see
 * trackMedia.
 */
export async function fetchTrackAudio(track: Pick<Track, 'id' | 'audioUrl'>, signal?: AbortSignal): Promise<Blob> {
  if (isLocalId(track.id)) return local(() => localAudio(track.id))
  const uid = cloudCacheUid()
  const kept = uid ? await cache.cachedAudio(uid, track.id) : null
  if (kept) return kept
  if (!track.audioUrl) throw new ApiError('This track has no audio', 'not_found', 404)
  let res = await trackMedia(uid, track.id, track.audioUrl, (t) => t.audioUrl, signal)
  if (res.status === 401 && uid) {
    await cache.forgetTrack(uid, track.id, ['track'])
    const fresh = await getTrack(track.id, signal)
    res = await mediaResponse(fresh.audioUrl, signal)
  }
  const blob = await mediaBlob(res)
  if (stillKeeping(uid) && blob.size > 0) await cache.saveAudio(uid, track.id, blob)
  return blob
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
