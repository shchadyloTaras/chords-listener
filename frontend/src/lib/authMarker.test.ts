// "Has this browser signed in before?" without Firebase: the localStorage flag, and the one-time look for
// a session Firebase saved before the flag existed (on fake-indexeddb).
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_MARKER_KEY, findLegacySession, rememberSignIn, signedInBefore } from './authMarker'
import { firebaseConfig } from './firebaseConfig'

const USER_KEY = `firebase:authUser:${firebaseConfig.apiKey}:[DEFAULT]`

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

/** Firebase Auth's IndexedDB persistence, as the SDK lays it out. */
function firebaseDb(records: { fbase_key: string; value: unknown }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('firebaseLocalStorageDb', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('firebaseLocalStorage', 'readwrite')
      for (const r of records) tx.objectStore('firebaseLocalStorage').put(r)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
    }
  })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the signed-in-before flag', () => {
  it('is set while signed in and cleared on sign-out', () => {
    expect(signedInBefore()).toBe(false)
    rememberSignIn(true)
    expect(localStorage.getItem(AUTH_MARKER_KEY)).toBe('1')
    expect(signedInBefore()).toBe(true)
    rememberSignIn(false)
    expect(localStorage.getItem(AUTH_MARKER_KEY)).toBeNull()
    expect(signedInBefore()).toBe(false)
  })

  it('reads as "never" where storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => rememberSignIn(true)).not.toThrow()
    expect(signedInBefore()).toBe(false)
  })
})

describe('findLegacySession', () => {
  it('finds nothing in a fresh browser, and creates no database', async () => {
    expect(await findLegacySession()).toBe(false)
    expect(await indexedDB.databases()).toEqual([])
  })

  it('finds nothing in the empty database older builds created for every guest', async () => {
    await firebaseDb([])
    expect(await findLegacySession()).toBe(false)
  })

  it('finds a session saved in IndexedDB', async () => {
    await firebaseDb([{ fbase_key: USER_KEY, value: { uid: 'uid42' } }])
    expect(await findLegacySession()).toBe(true)
  })

  describe('in a browser without indexedDB.databases() (Firefox < 126, Safari < 14)', () => {
    const withoutDatabases = () => Object.defineProperty(indexedDB, 'databases', { value: undefined, configurable: true })
    const databases = () => IDBFactory.prototype.databases.call(indexedDB)

    it('finds a session saved in IndexedDB', async () => {
      await firebaseDb([{ fbase_key: USER_KEY, value: { uid: 'uid42' } }])
      withoutDatabases()
      expect(await findLegacySession()).toBe(true)
    })

    it('finds nothing in a fresh browser, and creates no database', async () => {
      withoutDatabases()
      expect(await findLegacySession()).toBe(false)
      expect(await databases()).toEqual([])
    })
  })

  it('finds a session saved in localStorage (no IndexedDB there)', async () => {
    localStorage.setItem(USER_KEY, '{"uid":"uid42"}')
    expect(await findLegacySession()).toBe(true)
  })
})
