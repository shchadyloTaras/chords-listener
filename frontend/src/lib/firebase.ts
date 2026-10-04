// Firebase app for project "build-chords-listener" (web app "chords-listener-web").
// Web config values identify the project; they are not secrets. Access to data is
// enforced by Firebase Auth + /firestore.rules.
//
// Never import this module statically: lib/auth.ts loads it on demand, so Firebase lives in
// lazy chunks and the app keeps working when Firebase is blocked or unreachable.
import { initializeApp } from 'firebase/app'
import { browserLocalPersistence, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth'

export const firebaseConfig = {
  apiKey: 'AIzaSyBL5s4iSoBMrQNIlpYA4WQSjP5tP_4xmUU',
  authDomain: 'build-chords-listener.firebaseapp.com',
  projectId: 'build-chords-listener',
  storageBucket: 'build-chords-listener.firebasestorage.app',
  messagingSenderId: '84488579848',
  appId: '1:84488579848:web:0072b14b7aa305ef73dabd',
  measurementId: 'G-DCYT55LJJ2',
}

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
