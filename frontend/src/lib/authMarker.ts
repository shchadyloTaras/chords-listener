// "Has this browser signed in before?", answered without Firebase: lib/auth.ts restores a saved session
// at startup only then, so a guest never downloads the Firebase SDK (nor talks to Google) until they
// open the account dialog. A small localStorage flag, set while signed in and cleared on sign-out.
import { firebaseConfig } from './firebaseConfig'

export const AUTH_MARKER_KEY = 'chords-listener-auth'

export function signedInBefore(): boolean {
  try {
    return localStorage.getItem(AUTH_MARKER_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberSignIn(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(AUTH_MARKER_KEY, '1')
    else localStorage.removeItem(AUTH_MARKER_KEY)
  } catch {
    /* storage blocked: the session is restored only after the next sign-in */
  }
}

/** Another tab of this site signed in: `fn` runs there too (the SDK is not loaded here yet to notice). */
export function onSignInElsewhere(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onStorage = (e: StorageEvent) => {
    if (e.key === AUTH_MARKER_KEY && e.newValue === '1') fn()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

// Firebase Auth's own persistence (IndexedDB, or localStorage where IndexedDB is unavailable).
const FIREBASE_DB = 'firebaseLocalStorageDb'
const FIREBASE_STORE = 'firebaseLocalStorage'
const FIREBASE_USER_KEY = `firebase:authUser:${firebaseConfig.apiKey}:[DEFAULT]`

/**
 * One-time migration: a session Firebase saved before the flag existed (signed in with an older build),
 * looked up in Firebase's storage without the SDK. Never creates the database where it is missing.
 */
export async function findLegacySession(): Promise<boolean> {
  try {
    if (localStorage.getItem(FIREBASE_USER_KEY)) return true
  } catch {
    /* no localStorage */
  }
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return false
    if (!(await indexedDB.databases()).some((db) => db.name === FIREBASE_DB)) return false
    return await new Promise<boolean>((resolve) => {
      const open = indexedDB.open(FIREBASE_DB)
      // gone meanwhile: do not create it
      open.onupgradeneeded = () => open.transaction?.abort()
      open.onerror = () => resolve(false)
      open.onsuccess = () => {
        const db = open.result
        const done = (found: boolean) => {
          db.close()
          resolve(found)
        }
        try {
          if (!db.objectStoreNames.contains(FIREBASE_STORE)) return done(false)
          const get = db.transaction(FIREBASE_STORE, 'readonly').objectStore(FIREBASE_STORE).get(FIREBASE_USER_KEY)
          get.onsuccess = () => done(!!get.result)
          get.onerror = () => done(false)
        } catch {
          done(false)
        }
      }
    })
  } catch {
    return false
  }
}
