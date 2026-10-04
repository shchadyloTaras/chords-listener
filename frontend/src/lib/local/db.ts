// Persistence for tracks analyzed in the browser: IndexedDB database "chords-listener" with
//  · "tracks" — metadata + detection + user edits (small, listed often)
//  · "audio"  — the audio Blob per track (read only when a track is opened)
// Falls back to an in-memory store when IndexedDB is unavailable (tracks then last for the session).
import type { BrowserAnalysis } from '../engine'
import type { ChordSegment, TrackSource } from '../../types'

export interface LocalTrackRecord {
  id: string
  title: string
  artist: string | null
  createdAt: string
  updatedAt: string
  source: TrackSource
  /** MIME type and byte size of the stored audio */
  mime: string
  size: number
  /** what the in-browser engine detected (never overwritten by edits) */
  analysis: BrowserAnalysis
  /** the user's chord edits; null = none */
  edits: ChordSegment[] | null
}

export interface LocalRepo {
  /** "indexeddb" persists across reloads, "memory" does not */
  readonly kind: 'indexeddb' | 'memory'
  list(): Promise<LocalTrackRecord[]>
  get(id: string): Promise<LocalTrackRecord | undefined>
  /** updates metadata only (audio untouched) */
  put(rec: LocalTrackRecord): Promise<void>
  /** stores a new track together with its audio, atomically */
  putWithAudio(rec: LocalTrackRecord, audio: Blob): Promise<void>
  audio(id: string): Promise<Blob | undefined>
  /** false when there was nothing to delete */
  delete(id: string): Promise<boolean>
}

// ------------------------------------------------------------------ in-memory

export function createMemoryRepo(): LocalRepo {
  const tracks = new Map<string, LocalTrackRecord>()
  const audio = new Map<string, Blob>()
  const clone = (r: LocalTrackRecord): LocalTrackRecord => structuredClone(r)
  return {
    kind: 'memory',
    list: async () => [...tracks.values()].map(clone),
    get: async (id) => {
      const r = tracks.get(id)
      return r ? clone(r) : undefined
    },
    put: async (rec) => {
      tracks.set(rec.id, clone(rec))
    },
    putWithAudio: async (rec, blob) => {
      tracks.set(rec.id, clone(rec))
      audio.set(rec.id, blob)
    },
    audio: async (id) => audio.get(id),
    delete: async (id) => {
      audio.delete(id)
      return tracks.delete(id)
    },
  }
}

// ------------------------------------------------------------------ IndexedDB

const DB_NAME = 'chords-listener'
const DB_VERSION = 1
const TRACKS = 'tracks'
const AUDIO = 'audio'

/** Stored audio row. `buffer` is used where the browser cannot store Blobs in IndexedDB. */
interface AudioRow {
  id: string
  blob?: Blob
  buffer?: ArrayBuffer
  type?: string
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      // another tab upgrades the schema: let it, reopen on next use
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

function isCloneError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'DataCloneError' || err.name === 'NotSupportedError')
}

async function writeTrack(rec: LocalTrackRecord, row?: AudioRow): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(row ? [TRACKS, AUDIO] : [TRACKS], 'readwrite')
  const finished = done(tx)
  tx.objectStore(TRACKS).put(rec)
  if (row) tx.objectStore(AUDIO).put(row)
  await finished
}

const idbRepo: LocalRepo = {
  kind: 'indexeddb',
  async list() {
    const db = await openDb()
    return promisify(db.transaction(TRACKS).objectStore(TRACKS).getAll() as IDBRequest<LocalTrackRecord[]>)
  },
  async get(id) {
    const db = await openDb()
    return promisify(db.transaction(TRACKS).objectStore(TRACKS).get(id) as IDBRequest<LocalTrackRecord | undefined>)
  },
  put: (rec) => writeTrack(rec),
  async putWithAudio(rec, blob) {
    try {
      await writeTrack(rec, { id: rec.id, blob })
    } catch (err) {
      if (!isCloneError(err)) throw err
      // older WebKit: Blobs cannot go into IndexedDB, raw bytes can
      await writeTrack(rec, { id: rec.id, buffer: await blob.arrayBuffer(), type: blob.type })
    }
  },
  async audio(id) {
    const db = await openDb()
    const row = await promisify(db.transaction(AUDIO).objectStore(AUDIO).get(id) as IDBRequest<AudioRow | undefined>)
    if (!row) return undefined
    if (row.blob) return row.blob
    return row.buffer ? new Blob([row.buffer], { type: row.type ?? '' }) : undefined
  },
  async delete(id) {
    const db = await openDb()
    const tx = db.transaction([TRACKS, AUDIO], 'readwrite')
    const finished = done(tx)
    let existed = false
    const count = tx.objectStore(TRACKS).count(id)
    count.onsuccess = () => {
      existed = count.result > 0
    }
    // requests run in order inside one transaction: the count sees the row before it goes
    tx.objectStore(TRACKS).delete(id)
    tx.objectStore(AUDIO).delete(id)
    await finished
    return existed
  },
}

// ------------------------------------------------------------------ selection

let repoPromise: Promise<LocalRepo> | null = null

/** The browser's track store (IndexedDB, or memory when storage is blocked). */
export function localRepo(): Promise<LocalRepo> {
  repoPromise ??= (async () => {
    if (typeof indexedDB === 'undefined') return createMemoryRepo()
    try {
      await openDb()
      return idbRepo
    } catch {
      return createMemoryRepo()
    }
  })()
  return repoPromise
}

/** Tests: swap the store. */
export function setLocalRepo(repo: LocalRepo | null): void {
  repoPromise = repo ? Promise.resolve(repo) : null
}

let persistAsked = false

/** Asks the browser not to evict the library under storage pressure (once per session, best effort). */
export function requestPersistentStorage(): void {
  if (persistAsked || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistAsked = true
  void navigator.storage
    .persisted()
    .then((already) => (already ? true : navigator.storage.persist()))
    .catch(() => false)
}
