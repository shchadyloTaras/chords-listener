// Live-piano notes in the browser library: the memory store, and the real IndexedDB schema upgrade
// (version 1 → 2 adds the "notes" store) on fake-indexeddb, keeping existing tracks.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackNotes } from '../../types'

const NOTES: TrackNotes = {
  version: 1,
  engine: 'basic-pitch test',
  notes: [
    [0.5, 1.25, 60, 0.8],
    [0.5, 2, 64, 0.6],
  ],
}

function record(id: string) {
  return {
    id,
    title: 'Song',
    artist: null,
    createdAt: '2026-10-04T12:00:00Z',
    updatedAt: '2026-10-04T12:00:00Z',
    source: { type: 'file', url: null, videoId: null, filename: 'song.wav' },
    mime: 'audio/wav',
    size: 4,
    analysis: {
      duration: 8,
      tempo: 120,
      timeSignature: 4,
      beats: [0, 0.5],
      downbeats: [0],
      chords: [{ start: 0, end: 8, label: 'C', root: 'C', quality: 'maj', bass: null, confidence: 0.9 }],
      key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0.8 },
      waveform: [0.1],
      engine: 'test 1',
    },
    edits: null,
  }
}

describe('notes in the memory library', () => {
  beforeEach(() => vi.resetModules())

  it('stores, replaces and deletes notes together with the track', async () => {
    const local = await import('.')
    const repo = local.createMemoryRepo()
    local.setLocalRepo(repo)
    await repo.putWithAudio(record('local-aaaaaaaaaaaa') as never, new Blob(['abcd']))
    expect(await local.getLocalNotes('local-aaaaaaaaaaaa')).toBeNull()
    await local.putLocalNotes('local-aaaaaaaaaaaa', NOTES)
    expect(await local.getLocalNotes('local-aaaaaaaaaaaa')).toEqual(NOTES)
    // stored as a copy
    const got = (await local.getLocalNotes('local-aaaaaaaaaaaa'))!
    got.notes.length = 0
    expect((await local.getLocalNotes('local-aaaaaaaaaaaa'))!.notes).toHaveLength(2)
    await local.putLocalNotes('local-aaaaaaaaaaaa', { ...NOTES, notes: [[1, 2, 62, 0.5]] })
    expect((await local.getLocalNotes('local-aaaaaaaaaaaa'))!.notes).toEqual([[1, 2, 62, 0.5]])
    await local.deleteLocalTrack('local-aaaaaaaaaaaa')
    expect(await repo.getNotes('local-aaaaaaaaaaaa')).toBeUndefined()
    await expect(local.getLocalNotes('local-aaaaaaaaaaaa')).rejects.toMatchObject({ code: 'not_found' })
    await expect(local.putLocalNotes('local-aaaaaaaaaaaa', NOTES)).rejects.toMatchObject({ code: 'not_found' })
    local.setLocalRepo(null)
  })
})

describe('IndexedDB schema upgrade', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
  })
  afterEach(() => vi.resetModules())

  /** A database as version 1 of the app left it: tracks + audio, no notes store. */
  function createV1(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('chords-listener', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('tracks', { keyPath: 'id' })
        req.result.createObjectStore('audio', { keyPath: 'id' })
      }
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['tracks', 'audio'], 'readwrite')
        tx.objectStore('tracks').put(record(id))
        tx.objectStore('audio').put({ id, buffer: new Uint8Array([1, 2, 3, 4]).buffer, type: 'audio/wav' })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
  }

  it('upgrades version 1 without losing tracks or audio, then keeps notes', async () => {
    const id = 'local-0123456789ab'
    await createV1(id)
    const db = await import('./db')
    expect(db.DB_VERSION).toBe(2)
    const repo = await db.localRepo()
    expect(repo.kind).toBe('indexeddb')

    const tracks = await repo.list()
    expect(tracks.map((t) => t.id)).toEqual([id])
    expect(tracks[0].analysis.chords[0].label).toBe('C')
    const audio = await repo.audio(id)
    expect(audio?.size).toBe(4)

    expect(await repo.getNotes(id)).toBeUndefined()
    await repo.putNotes(id, NOTES)
    expect(await repo.getNotes(id)).toEqual(NOTES)

    // the schema really is version 2 with a notes store
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('chords-listener')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(raw.version).toBe(2)
    expect([...raw.objectStoreNames].sort()).toEqual(['audio', 'notes', 'tracks'])
    raw.close()

    // deleting the track removes its notes as well
    expect(await repo.delete(id)).toBe(true)
    expect(await repo.getNotes(id)).toBeUndefined()
    expect(await repo.list()).toEqual([])
  })

  it('creates all stores for a new database', async () => {
    const db = await import('./db')
    const repo = await db.localRepo()
    await repo.putWithAudio(record('local-bbbbbbbbbbbb') as never, new Blob(['x']))
    await repo.putNotes('local-bbbbbbbbbbbb', NOTES)
    expect(await repo.getNotes('local-bbbbbbbbbbbb')).toEqual(NOTES)
    expect((await repo.list()).length).toBe(1)
  })
})
