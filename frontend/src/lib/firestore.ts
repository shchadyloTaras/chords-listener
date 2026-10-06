// The one Firestore instance of the web client: settings sync (lib/settingsSync.ts) and the live
// library read through it, so there is a single connection.
//
// Never import this module statically (like lib/firebase.ts): it is only loaded from modules that
// lib/auth.ts imports on sign-in, so guests never download Firestore.
//
// The cache is memory only (no IndexedDB persistence): nothing of one account's data stays in the
// browser for the next person who signs in on it.
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache } from 'firebase/firestore'
import { app, EMULATOR_HOST, FIRESTORE_EMULATOR_PORT, useEmulators } from './firebase'

export const db = initializeFirestore(app, { localCache: memoryLocalCache() })
if (useEmulators) connectFirestoreEmulator(db, EMULATOR_HOST, FIRESTORE_EMULATOR_PORT)
