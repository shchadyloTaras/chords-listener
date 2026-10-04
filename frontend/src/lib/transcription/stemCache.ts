// Notes transcribed from a separated stem (the instruments of a server track, see lib/vocals): the
// server keeps only the full-mix notes (notes.json), so these stay on this device — IndexedDB
// database "chords-listener-stems", store "notes", the newest 16 tracks. Falls back to memory.
import type { TrackNotes } from '../../types'

const DB_NAME = 'chords-listener-stems'
const STORE = 'notes'
const KEEP = 16

interface Row {
  key: string
  notes: TrackNotes
  savedAt: number
}

const memory = new Map<string, Row>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getStemNotes(key: string): Promise<TrackNotes | null> {
  const db = await openDb()
  if (!db) return memory.get(key)?.notes ?? null
  try {
    const row = (await done(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))) as Row | undefined
    return row?.notes ?? null
  } catch {
    return memory.get(key)?.notes ?? null
  }
}

export async function putStemNotes(key: string, notes: TrackNotes): Promise<void> {
  const row: Row = { key, notes, savedAt: Date.now() }
  const db = await openDb()
  if (!db) {
    memory.set(key, row)
    return
  }
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
  await done(store.put(row))
  // keep the newest KEEP rows
  const all = (await done(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) as Row[]
  if (all.length <= KEEP) return
  const old = all.sort((a, b) => b.savedAt - a.savedAt).slice(KEEP)
  const tx = db.transaction(STORE, 'readwrite').objectStore(STORE)
  await Promise.all(old.map((r) => done(tx.delete(r.key))))
}

/** Tests: forget the in-memory fallback and the connection. */
export function resetStemCache(): void {
  memory.clear()
  dbPromise = null
}
