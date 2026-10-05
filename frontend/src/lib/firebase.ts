// Firebase app for project "build-chords-listener" (config in lib/firebaseConfig.ts).
//
// Never import this module statically: lib/auth.ts loads it on demand (only once someone opens the
// account dialog, or this browser has signed in before), so Firebase lives in lazy chunks, guests never
// download it, and the app keeps working when Firebase is blocked or unreachable.
import { initializeApp } from 'firebase/app'
import { browserLocalPersistence, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth'
import { firebaseConfig } from './firebaseConfig'

/**
 * `VITE_FIREBASE_EMULATORS=true npx vite` talks to `firebase emulators:start` (auth :9099,
 * firestore :8080, see /firebase.json) instead of production.
 */
export const useEmulators = import.meta.env.VITE_FIREBASE_EMULATORS === 'true'
export const EMULATOR_HOST = '127.0.0.1'
export const AUTH_EMULATOR_PORT = 9099
export const FIRESTORE_EMULATOR_PORT = 8080

export const app = initializeApp(firebaseConfig)

// Email/password only: initializeAuth without the popup/redirect resolver keeps the chunk small.
// The session survives reloads (IndexedDB, or localStorage where IndexedDB is unavailable).
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })

if (useEmulators) {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${AUTH_EMULATOR_PORT}`, { disableWarnings: true })
}
