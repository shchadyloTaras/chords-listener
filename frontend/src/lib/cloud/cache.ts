// The signed-in user's cloud library kept on this device, so opening the site and replaying a song ask the
// cloud nothing (any request wakes a Cloud Run instance, billed ~15 min). IndexedDB database
// "chords-listener-cloud", separate from the browser library ("chords-listener", lib/local): every row is
// keyed by the account's uid, and the whole database goes on sign-out or when another account signs in
// (lib/auth.ts). Callers (lib/api.ts, lib/vocals.ts, the player) use it only while the API is the cloud and
// someone is signed in — never for a local server or a guest.
//  · "lists"  — key uid: the library list (GET /tracks) as the server sent it, asked again after LIST_TTL_MS
//  · "tracks" — key `${uid}|${id}`: the track (GET /tracks/{id}), its signed media URLs included, for TRACK_TTL_MS
//  · "audio"  — key `${uid}|${id}`: the audio file, least recently played evicted over AUDIO_BUDGET_BYTES
//  · "json"   — key `${uid}|${kind}|${id}`: live-piano notes and vocal notes
// Rows are `{ key, value, savedAt, size? }`. Nothing here throws: without IndexedDB (or with a broken one)
// every read is null and every write does nothing.
import type { Track, TrackSummary } from '../../types'

/** The list is asked again when older than this (a track added on another device shows up by then). */
export const LIST_TTL_MS = 10 * 60_000
/**
 * A kept track is used for this long. Shorter than the signed media URLs live (12–13 h, docs/CLOUD.md
 * "Media URLs"), so the `audioUrl` / `stemUrls` of a track served from here still play. Keep it that way.
 */
export const TRACK_TTL_MS = 6 * 3600_000
/** Audio kept on this device, all accounts together. */
export const AUDIO_BUDGET_BYTES = 300 * 1024 * 1024
/** How long an IndexedDB that does not answer (seen in some browsers) may hold a caller up. */
export const OPEN_TIMEOUT_MS = 2000

/** Saved less than `ttl` ago (a clock that went back makes nothing look fresh forever). */
export function isFresh(savedAt: number, ttl: number): boolean {
  const age = Date.now() - savedAt
  return age >= 0 && age < ttl
}

export type JsonKind = 'notes' | 'vocals'
/** What `forgetTrack` can drop: the track's JSON, audio, notes, vocal notes, its entry in the list. */
export type TrackPart = 'track' | 'audio' | 'notes' | 'vocals' | 'listed'

const ALL_PARTS: readonly TrackPart[] = ['track', 'audio', 'notes', 'vocals', 'listed']

const DB_NAME = 'chords-listener-cloud'
const DB_VERSION = 1
const LISTS = 'lists'
const TRACKS = 'tracks'
const AUDIO = 'audio'
const JSON_STORE = 'json'
type StoreName = typeof LISTS | typeof TRACKS | typeof AUDIO | typeof JSON_STORE

interface Row<T> {
  key: string
  value: T
  savedAt: number
  /** bytes, audio rows only */
  size?: number
}

/** A stored audio file: a Blob, or its bytes where the browser cannot keep Blobs in IndexedDB (older WebKit). */
type StoredAudio = Blob | { buffer: ArrayBuffer; type: string }

const trackKey = (uid: string, id: string) => `${uid}|${id}`
const jsonKey = (uid: string, kind: JsonKind, id: string) => `${uid}|${kind}|${id}`

// ------------------------------------------------------------------ connection

/** The open database, per IndexedDB factory (checked on every call: a page may lose it, tests swap it). */
let opened: { factory: IDBFactory; db: Promise<IDBDatabase> } | null = null

function openDb(): Promise<IDBDatabase> {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (!factory) return Promise.reject(new Error('IndexedDB is not available'))
  if (opened?.factory === factory) return opened.db
  const db: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
    let late = false
    const timer = setTimeout(() => {
      late = true
      reject(new Error('IndexedDB does not answer'))
    }, OPEN_TIMEOUT_MS)
    const req = factory.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      for (const name of [LISTS, TRACKS, AUDIO, JSON_STORE])
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'key' })
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      const d = req.result
      if (late) {
        d.close()
        return
      }
      // the database is being deleted (sign-out in another tab) or upgraded: let it, reopen on next use
      d.onversionchange = () => {
        d.close()
        forget()
      }
      d.onclose = forget
      resolve(d)
    }
    req.onerror = () => {
      clearTimeout(timer)
      reject(req.error)
    }
  })
  const forget = () => {
    if (opened?.db === db) opened = null
  }
  // failed or too slow: the next call tries again
  db.catch(forget)
  opened = { factory, db }
  return db
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

/** Runs `work` in one transaction (only IndexedDB requests may be awaited inside); throws on any failure. */
async function transact<T>(stores: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDb()
  const tx = db.transaction(stores, mode)
  const done = finished(tx)
  try {
    const result = await work(tx)
    await done
    return result
  } catch (err) {
    done.catch(() => undefined)
    try {
      tx.abort()
    } catch {
      /* already over */
    }
    throw err
  }
}

/** `op` with failures (no IndexedDB, quota, a broken database) turned into `fallback`. */
async function safely<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op()
  } catch {
    return fallback
  }
}

const getRow = <T>(store: IDBObjectStore, key: string) => promisify(store.get(key) as IDBRequest<Row<T> | undefined>)

// ------------------------------------------------------------------ list

/** The library list kept for `uid`, and when it was saved (any age: the caller decides about LIST_TTL_MS). */
export function cachedList(uid: string): Promise<{ tracks: TrackSummary[]; savedAt: number } | null> {
  return safely(
    () =>
      transact([LISTS], 'readonly', async (tx) => {
        const row = await getRow<TrackSummary[]>(tx.objectStore(LISTS), uid)
        return row && Array.isArray(row.value) ? { tracks: row.value, savedAt: row.savedAt } : null
      }),
    null,
  )
}

/** Keeps the library list the server just sent. */
export function saveList(uid: string, tracks: TrackSummary[]): Promise<void> {
  const row: Row<TrackSummary[]> = { key: uid, value: tracks, savedAt: Date.now() }
  return safely(
    () =>
      transact([LISTS], 'readwrite', async (tx) => {
        tx.objectStore(LISTS).put(row)
      }),
    undefined,
  )
}

// ------------------------------------------------------------------ tracks

const TRACK_ONLY = [
  'audioUrl',
  'timeSignature',
  'beats',
  'downbeats',
  'chords',
  'waveform',
  'engine',
  'startOffset',
  'stemUrls',
] as const satisfies readonly Exclude<keyof Track, keyof TrackSummary>[]

/** The list entry of a track (the list holds summaries, as GET /tracks sends them). */
function summaryOf(track: Track): TrackSummary {
  const summary: Record<string, unknown> = { ...track }
  for (const k of TRACK_ONLY) delete summary[k]
  return summary as unknown as TrackSummary
}

/** The track kept for `uid`, while younger than TRACK_TTL_MS (its signed URLs still play); else null. */
export function cachedTrack(uid: string, id: string): Promise<Track | null> {
  return safely(
    () =>
      transact([TRACKS], 'readonly', async (tx) => {
        const row = await getRow<Track>(tx.objectStore(TRACKS), trackKey(uid, id))
        if (!row || !isFresh(row.savedAt, TRACK_TTL_MS)) return null
        return row.value
      }),
    null,
  )
}

/**
 * Keeps a track the server just sent (opened, edited, reset) and refreshes its entry in the kept list, if
 * listed there — the list keeps its age (it is not asked again any sooner or later because of this).
 */
export function saveTrack(uid: string, track: Track): Promise<void> {
  const row: Row<Track> = { key: trackKey(uid, track.id), value: track, savedAt: Date.now() }
  return safely(
    () =>
      transact([TRACKS, LISTS], 'readwrite', async (tx) => {
        tx.objectStore(TRACKS).put(row)
        const lists = tx.objectStore(LISTS)
        const list = await getRow<TrackSummary[]>(lists, uid)
        if (!list || !Array.isArray(list.value) || !list.value.some((t) => t.id === track.id)) return
        const entry = summaryOf(track)
        lists.put({ ...list, value: list.value.map((t) => (t.id === track.id ? entry : t)) })
      }),
    undefined,
  )
}

/**
 * Drops what is kept of a track: everything (it was deleted), or just `parts` — e.g. its JSON when the server
 * changed it (re-analysis, vocals) or its signed URL ran out.
 */
export function forgetTrack(uid: string, id: string, parts: readonly TrackPart[] = ALL_PARTS): Promise<void> {
  const want = new Set(parts)
  const stores: StoreName[] = []
  if (want.has('track')) stores.push(TRACKS)
  if (want.has('audio')) stores.push(AUDIO)
  if (want.has('notes') || want.has('vocals')) stores.push(JSON_STORE)
  if (want.has('listed')) stores.push(LISTS)
  if (!stores.length) return Promise.resolve()
  return safely(
    () =>
      transact(stores, 'readwrite', async (tx) => {
        if (want.has('track')) tx.objectStore(TRACKS).delete(trackKey(uid, id))
        if (want.has('audio')) tx.objectStore(AUDIO).delete(trackKey(uid, id))
        if (want.has('notes')) tx.objectStore(JSON_STORE).delete(jsonKey(uid, 'notes', id))
        if (want.has('vocals')) tx.objectStore(JSON_STORE).delete(jsonKey(uid, 'vocals', id))
        if (!want.has('listed')) return
        const lists = tx.objectStore(LISTS)
        const list = await getRow<TrackSummary[]>(lists, uid)
        if (list && Array.isArray(list.value) && list.value.some((t) => t.id === id))
          lists.put({ ...list, value: list.value.filter((t) => t.id !== id) })
      }),
    undefined,
  )
}

// ------------------------------------------------------------------ audio

function isCloneError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'DataCloneError' || err.name === 'NotSupportedError')
}

function asBlob(value: StoredAudio | undefined): Blob | null {
  if (value instanceof Blob) return value
  if (value && value.buffer instanceof ArrayBuffer) return new Blob([value.buffer], { type: value.type ?? '' })
  return null
}

/** The audio file kept for `uid` (no expiry: it plays whatever its signed URL says); marks it recently used. */
export function cachedAudio(uid: string, id: string): Promise<Blob | null> {
  return safely(
    () =>
      transact([AUDIO], 'readwrite', async (tx) => {
        const store = tx.objectStore(AUDIO)
        const row = await getRow<StoredAudio>(store, trackKey(uid, id))
        const blob = asBlob(row?.value)
        if (!row || !blob) return null
        store.put({ ...row, savedAt: Date.now() })
        return blob
      }),
    null,
  )
}

/** Puts the row, then drops the least recently used files until all fit into AUDIO_BUDGET_BYTES. */
function putAudio(row: Row<StoredAudio>): Promise<void> {
  return transact([AUDIO], 'readwrite', async (tx) => {
    const store = tx.objectStore(AUDIO)
    store.put(row)
    const rows: { key: string; size: number; savedAt: number }[] = []
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return resolve()
        const r = cursor.value as Row<StoredAudio>
        rows.push({ key: r.key, size: r.size ?? 0, savedAt: r.savedAt })
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    // oldest first; the file just saved is the newest whatever the clock says
    rows.sort((a, b) => (a.key === row.key ? 1 : b.key === row.key ? -1 : a.savedAt - b.savedAt))
    let total = rows.reduce((sum, r) => sum + r.size, 0)
    for (const r of rows) {
      if (total <= AUDIO_BUDGET_BYTES) break
      store.delete(r.key)
      total -= r.size
    }
  })
}

/** Keeps a downloaded audio file (a file bigger than the whole budget is not kept). */
export function saveAudio(uid: string, id: string, blob: Blob): Promise<void> {
  if (blob.size > AUDIO_BUDGET_BYTES) return Promise.resolve()
  const row = (value: StoredAudio): Row<StoredAudio> => ({ key: trackKey(uid, id), value, savedAt: Date.now(), size: blob.size })
  return safely(async () => {
    try {
      await putAudio(row(blob))
    } catch (err) {
      if (!isCloneError(err)) throw err
      // older WebKit: Blobs cannot go into IndexedDB, raw bytes can
      await putAudio(row({ buffer: await blob.arrayBuffer(), type: blob.type }))
    }
  }, undefined)
}

// ------------------------------------------------------------------ notes, vocals

/** Live-piano notes ('notes') or vocal notes ('vocals') kept for `uid`. */
export function cachedJson<T>(uid: string, kind: JsonKind, id: string): Promise<T | null> {
  return safely(
    () =>
      transact([JSON_STORE], 'readonly', async (tx) => {
        const row = await getRow<T>(tx.objectStore(JSON_STORE), jsonKey(uid, kind, id))
        return row ? row.value : null
      }),
    null,
  )
}

export function saveJson<T>(uid: string, kind: JsonKind, id: string, value: T): Promise<void> {
  const row: Row<T> = { key: jsonKey(uid, kind, id), value, savedAt: Date.now() }
  return safely(
    () =>
      transact([JSON_STORE], 'readwrite', async (tx) => {
        tx.objectStore(JSON_STORE).put(row)
      }),
    undefined,
  )
}

// ------------------------------------------------------------------ sign-out

/** Deletes everything kept here (sign-out, another account). Other tabs let go of the database for it. */
export async function clearCloudCache(): Promise<void> {
  const previous = opened
  opened = null
  previous?.db.then(
    (db) => db.close(),
    () => undefined,
  )
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!factory) return
    await new Promise<void>((resolve) => {
      // blocked by a tab that does not let go: it goes once that tab closes; nobody waits for it meanwhile
      const timer = setTimeout(resolve, OPEN_TIMEOUT_MS)
      const settle = () => {
        clearTimeout(timer)
        resolve()
      }
      const req = factory.deleteDatabase(DB_NAME)
      req.onsuccess = settle
      req.onerror = settle
      req.onblocked = settle
    })
  } catch {
    /* nothing kept */
  }
}
