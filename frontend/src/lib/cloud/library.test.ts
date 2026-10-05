// The live library: the signed-in user's `users/{uid}/tracks` index in Firestore (published by the API) as a
// store. Firestore is mocked: `fs.listeners` holds what each onSnapshot was given, and `fs.gate` holds back
// the lazy `../firestore` import to play the races around it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Listener {
  path: unknown[]
  options: unknown
  next: (snap: unknown) => void
  error: (err: unknown) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const fs = vi.hoisted(() => ({
  /** how often the firebase/firestore module was evaluated */
  loads: 0,
  /** while set, `../firestore` (the db) is not available yet */
  gate: null as Promise<void> | null,
  /** the `../firestore` chunk fails to load */
  fail: false,
  listeners: [] as Listener[],
}))

const DB = { type: 'firestore' }

/** A fresh module graph (the store starts empty, nothing loaded), with Firestore standing in for the SDK. */
async function boot() {
  vi.resetModules()
  vi.doMock('firebase/firestore', () => {
    fs.loads++
    return {
      collection: (_db: unknown, ...path: string[]) => ({ path }),
      orderBy: (field: string, direction: string) => ({ field, direction }),
      query: (ref: { path: string[] }, ...constraints: unknown[]) => ({ ref, constraints }),
      onSnapshot: (q: { ref: { path: string[] } }, options: unknown, next: Listener['next'], error: Listener['error']) => {
        const unsubscribe = vi.fn()
        fs.listeners.push({ path: q.ref.path, options, next, error, unsubscribe })
        return unsubscribe
      },
    }
  })
  vi.doMock('../firestore', () => {
    const load = () => {
      if (fs.fail) throw new Error('chunk failed to load')
      return { db: DB }
    }
    return fs.gate ? fs.gate.then(load) : load()
  })
  return import('./library')
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The index document the API publishes for a track: TrackSummary + version + publishedAt. */
function indexDoc(id: string, version: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Song ${id}`,
    artist: null,
    duration: 180,
    thumbnail: null,
    source: { type: 'file', filename: `${id}.mp3` },
    key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0.9 },
    tempo: 120,
    chordCount: 40,
    edited: false,
    vocals: false,
    stems: [],
    createdAt: '2026-10-05T10:00:00Z',
    version,
    publishedAt: { seconds: 1_790_000_000, nanoseconds: 0 },
    ...extra,
  }
}

/**
 * A query snapshot. `changes`: what its docChanges() lists — by default one change (the documents are news); an
 * empty list is a metadata-only snapshot (online ↔ offline, cache ↔ server) with the same documents.
 */
function snapshot(docs: Array<ReturnType<typeof indexDoc>>, fromCache = false, changes: unknown[] = [{ type: 'modified' }]) {
  return {
    empty: docs.length === 0,
    metadata: { fromCache },
    docs: docs.map((d) => ({ id: d.id, data: () => d })),
    docChanges: () => changes,
  }
}

/** Holds back the `../firestore` import until `openGate()`. */
let openGate: () => void = () => undefined
function holdFirestore() {
  fs.gate = new Promise<void>((resolve) => (openGate = resolve))
}

beforeEach(() => {
  fs.loads = 0
  fs.gate = null
  fs.fail = false
  fs.listeners = []
  openGate = () => undefined
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the live library', () => {
  it('starts empty and not ready', async () => {
    const { libraryReady, useLibrary } = await boot()
    expect(useLibrary.getState()).toEqual({ uid: null, tracks: null, versions: {}, error: false })
    expect(libraryReady()).toBe(false)
  })

  it('listens to the account’s track index, newest first', async () => {
    const { startLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    expect(fs.listeners[0].path).toEqual(['users', 'u1', 'tracks'])
  })

  it('first snapshot fills tracks and versions', async () => {
    const { libraryReady, startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    expect(useLibrary.getState()).toMatchObject({ uid: 'u1', tracks: null })
    expect(libraryReady()).toBe(false)

    fs.listeners[0].next(snapshot([indexDoc('b', 3), indexDoc('a', 1)]))
    const { tracks, versions, error } = useLibrary.getState()
    expect(tracks?.map((t) => t.id)).toEqual(['b', 'a'])
    expect(tracks?.[0]).toMatchObject({ id: 'b', title: 'Song b', duration: 180, createdAt: '2026-10-05T10:00:00Z', version: 3 })
    // publishedAt is the index's own bookkeeping, not part of a TrackSummary
    expect(tracks?.[0]).not.toHaveProperty('publishedAt')
    expect(versions).toEqual({ b: 3, a: 1 })
    expect(error).toBe(false)
    expect(libraryReady()).toBe(true)
  })

  it('an empty library is ready once the server said so', async () => {
    const { libraryReady, startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([]))
    expect(useLibrary.getState().tracks).toEqual([])
    expect(libraryReady()).toBe(true)
  })

  it('a changed document updates versions', async () => {
    const { startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('a', 1), indexDoc('b', 1)]))
    fs.listeners[0].next(snapshot([indexDoc('a', 2, { edited: true }), indexDoc('b', 1)]))
    const { tracks, versions } = useLibrary.getState()
    expect(versions).toEqual({ a: 2, b: 1 })
    expect(tracks?.[0]).toMatchObject({ id: 'a', version: 2, edited: true })
  })

  it('a deleted document leaves the list and the versions', async () => {
    const { startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('a', 1), indexDoc('b', 1)]))
    fs.listeners[0].next(snapshot([indexDoc('b', 1)]))
    expect(useLibrary.getState().tracks?.map((t) => t.id)).toEqual(['b'])
    expect(useLibrary.getState().versions).toEqual({ b: 1 })
  })

  it('snapshot error keeps the last list and sets error, logging once', async () => {
    const { libraryReady, startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('a', 1)]))
    const before = useLibrary.getState().tracks

    fs.listeners[0].error(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }))
    fs.listeners[0].error(new Error('again'))
    expect(useLibrary.getState().tracks).toBe(before)
    expect(useLibrary.getState().versions).toEqual({ a: 1 })
    expect(useLibrary.getState().error).toBe(true)
    expect(libraryReady()).toBe(false)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('an error before any snapshot leaves no list, with error set', async () => {
    const { startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].error(new Error('unavailable'))
    expect(useLibrary.getState()).toMatchObject({ uid: 'u1', tracks: null, error: true })
  })

  it('a cache-only answer with nothing in it is not an empty library (offline, nothing cached yet)', async () => {
    const { libraryReady, startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    // the metadata change that tells cache from server must reach us, or the server's "still empty" would not
    expect(fs.listeners[0].options).toEqual({ includeMetadataChanges: true })
    fs.listeners[0].next(snapshot([], true))
    expect(useLibrary.getState().tracks).toBeNull()
    expect(libraryReady()).toBe(false)
    fs.listeners[0].next(snapshot([], false))
    expect(useLibrary.getState().tracks).toEqual([])
    expect(libraryReady()).toBe(true)
  })

  it('a metadata-only snapshot (online ↔ offline, cache ↔ server) leaves the store as it is', async () => {
    const { startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('a', 1)], true))
    const before = useLibrary.getState()
    const seen = vi.fn()
    useLibrary.subscribe(seen)
    // the server confirms the cached list, then the connection drops and comes back
    fs.listeners[0].next(snapshot([indexDoc('a', 1)], false, []))
    fs.listeners[0].next(snapshot([indexDoc('a', 1)], true, []))
    expect(seen).not.toHaveBeenCalled()
    expect(useLibrary.getState()).toBe(before)
    // a real change still lands
    fs.listeners[0].next(snapshot([indexDoc('a', 2)]))
    expect(useLibrary.getState().versions).toEqual({ a: 2 })
  })

  it('a cache-only list that has tracks is used', async () => {
    const { startLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('a', 1)], true))
    expect(useLibrary.getState().tracks?.map((t) => t.id)).toEqual(['a'])
  })

  it('starting again for the same account listens once', async () => {
    const { startLibrary } = await boot()
    startLibrary('u1')
    startLibrary('u1')
    await settle()
    startLibrary('u1')
    await settle()
    expect(fs.listeners).toHaveLength(1)
    expect(fs.listeners[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('stopping unsubscribes and empties the store synchronously', async () => {
    const { libraryReady, startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('u1')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('a', 1)]))
    stopLibrary()
    expect(fs.listeners[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(useLibrary.getState()).toEqual({ uid: null, tracks: null, versions: {}, error: false })
    expect(libraryReady()).toBe(false)
  })

  it('stopping an idle library is harmless', async () => {
    const { stopLibrary, useLibrary } = await boot()
    const seen = vi.fn()
    useLibrary.subscribe(seen)
    stopLibrary()
    stopLibrary()
    expect(seen).not.toHaveBeenCalled()
    expect(useLibrary.getState().uid).toBeNull()
  })

  it('switching accounts drops the old list', async () => {
    const { startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('a')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('t1', 1)]))
    expect(useLibrary.getState().tracks).toHaveLength(1)

    stopLibrary()
    expect(useLibrary.getState()).toEqual({ uid: null, tracks: null, versions: {}, error: false })
    expect(fs.listeners[0].unsubscribe).toHaveBeenCalledTimes(1)

    startLibrary('b')
    expect(useLibrary.getState()).toEqual({ uid: 'b', tracks: null, versions: {}, error: false })
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(2))
    expect(fs.listeners[1].path).toEqual(['users', 'b', 'tracks'])
    // still empty until b's own snapshot
    expect(useLibrary.getState().tracks).toBeNull()
    fs.listeners[1].next(snapshot([indexDoc('t9', 5)]))
    expect(useLibrary.getState().tracks?.map((t) => t.id)).toEqual(['t9'])
  })

  it('starting for another account without a stop replaces the listener', async () => {
    const { startLibrary, useLibrary } = await boot()
    startLibrary('a')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    fs.listeners[0].next(snapshot([indexDoc('t1', 1)]))
    startLibrary('b')
    expect(fs.listeners[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(useLibrary.getState()).toEqual({ uid: 'b', tracks: null, versions: {}, error: false })
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(2))
    expect(fs.listeners[1].path).toEqual(['users', 'b', 'tracks'])
  })

  it('a snapshot or an error arriving for an old account after a stop writes nothing', async () => {
    const { startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('a')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    stopLibrary()
    startLibrary('b')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(2))

    fs.listeners[0].next(snapshot([indexDoc('t1', 1)]))
    fs.listeners[0].error(new Error('late'))
    expect(useLibrary.getState()).toEqual({ uid: 'b', tracks: null, versions: {}, error: false })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a snapshot arriving after a stop leaves the store empty', async () => {
    const { startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('a')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    stopLibrary()
    fs.listeners[0].next(snapshot([indexDoc('t1', 1)]))
    expect(useLibrary.getState()).toEqual({ uid: null, tracks: null, versions: {}, error: false })
  })
})

describe('while Firestore is still loading', () => {
  it('stop during the import: the late import attaches no listener', async () => {
    holdFirestore()
    const { startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('a')
    await settle()
    stopLibrary()
    openGate()
    await settle()
    await settle()
    expect(fs.listeners).toHaveLength(0)
    expect(useLibrary.getState()).toEqual({ uid: null, tracks: null, versions: {}, error: false })
  })

  it('another account during the import: only the new account is listened to', async () => {
    holdFirestore()
    const { startLibrary, useLibrary } = await boot()
    startLibrary('a')
    startLibrary('b')
    await settle()
    openGate()
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    await settle()
    expect(fs.listeners).toHaveLength(1)
    expect(fs.listeners[0].path).toEqual(['users', 'b', 'tracks'])
    expect(useLibrary.getState().uid).toBe('b')
  })

  it('stop and start again for the same account during the import: one listener', async () => {
    holdFirestore()
    const { startLibrary, stopLibrary } = await boot()
    startLibrary('a')
    stopLibrary()
    startLibrary('a')
    await settle()
    openGate()
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    await settle()
    expect(fs.listeners).toHaveLength(1)
    expect(fs.listeners[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('a failed import sets error and logs once; stopping and starting tries again', async () => {
    fs.fail = true
    const { startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('a')
    await vi.waitFor(() => expect(useLibrary.getState().error).toBe(true))
    expect(useLibrary.getState()).toMatchObject({ uid: 'a', tracks: null })
    expect(console.warn).toHaveBeenCalledTimes(1)

    fs.fail = false
    stopLibrary()
    startLibrary('a')
    await vi.waitFor(() => expect(fs.listeners).toHaveLength(1))
    expect(useLibrary.getState().error).toBe(false)
  })

  it('a failed import of an account that was stopped meanwhile is not reported', async () => {
    holdFirestore()
    fs.fail = true
    const { startLibrary, stopLibrary, useLibrary } = await boot()
    startLibrary('a')
    stopLibrary()
    openGate()
    await settle()
    await settle()
    expect(useLibrary.getState()).toEqual({ uid: null, tracks: null, versions: {}, error: false })
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('guests', () => {
  it('never import firebase/firestore: nothing is loaded until a library is started', async () => {
    const { libraryReady, stopLibrary } = await boot()
    await settle()
    stopLibrary()
    expect(libraryReady()).toBe(false)
    expect(fs.loads).toBe(0)
  })

  it('starting a library is what loads it', async () => {
    const { startLibrary } = await boot()
    startLibrary('a')
    await vi.waitFor(() => expect(fs.loads).toBe(1))
  })
})
