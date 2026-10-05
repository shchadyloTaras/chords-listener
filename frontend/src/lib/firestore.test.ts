// The one Firestore instance (lib/firestore) shared by settings sync and the live library: memory cache
// only, so no account's data stays in the browser's IndexedDB for the next one. Firebase is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => {
  const instance = { type: 'firestore' }
  const cache = { kind: 'memory' }
  return {
    instance,
    cache,
    initializeFirestore: vi.fn(() => instance),
    memoryLocalCache: vi.fn(() => cache),
    connectFirestoreEmulator: vi.fn(),
    getFirestore: vi.fn(() => instance),
  }
})

vi.mock('firebase/firestore', () => ({
  initializeFirestore: fs.initializeFirestore,
  memoryLocalCache: fs.memoryLocalCache,
  connectFirestoreEmulator: fs.connectFirestoreEmulator,
  getFirestore: fs.getFirestore,
  doc: vi.fn(),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
}))

const app = { name: '[DEFAULT]' }

/** A fresh module graph, with `./firebase` standing in for the Firebase app. */
function mockFirebase(useEmulators: boolean) {
  vi.resetModules()
  vi.doMock('./firebase', () => ({ app, useEmulators, EMULATOR_HOST: '127.0.0.1', FIRESTORE_EMULATOR_PORT: 8080 }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('lib/firestore', () => {
  it('creates the instance once, with the memory cache', async () => {
    mockFirebase(false)
    const mod = await import('./firestore')
    expect(fs.initializeFirestore).toHaveBeenCalledTimes(1)
    expect(fs.initializeFirestore).toHaveBeenCalledWith(app, { localCache: fs.cache })
    expect(fs.memoryLocalCache).toHaveBeenCalledTimes(1)
    expect(mod.db).toBe(fs.instance)
  })

  it('does not touch the emulator in production', async () => {
    mockFirebase(false)
    await import('./firestore')
    expect(fs.connectFirestoreEmulator).not.toHaveBeenCalled()
  })

  it('connects to the emulator when it is enabled', async () => {
    mockFirebase(true)
    await import('./firestore')
    expect(fs.connectFirestoreEmulator).toHaveBeenCalledTimes(1)
    expect(fs.connectFirestoreEmulator).toHaveBeenCalledWith(fs.instance, '127.0.0.1', 8080)
  })

  it('is the instance settings sync uses, which creates none of its own', async () => {
    mockFirebase(false)
    await import('./settingsSync')
    expect(fs.getFirestore).not.toHaveBeenCalled()
    expect(fs.initializeFirestore).toHaveBeenCalledTimes(1)
  })
})
