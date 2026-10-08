// Firebase Auth (email/password): session state for the UI + account actions.
// Signing in syncs settings (lib/settingsSync.ts) and, on the hosted site, switches the API to the
// cloud (lib/serverMode.ts), which gets the user's ID token with every request (lib/api.ts).
// Firebase is loaded on demand into separate chunks, so a blocked or unreachable Firebase only
// disables the account features, never the app. A guest never loads it: only opening the account
// dialog does, or a startup in a browser that has signed in before (lib/authMarker.ts).
// The cloud library kept on the device (lib/cloud/cache) and the live one (lib/cloud/library) belong to the
// signed-in account alone: they go on sign-out and when another account signs in.
import type { Auth } from 'firebase/auth'
import { create } from 'zustand'
import { useApp } from '../store'
import { findLegacySession, onSignInElsewhere, rememberSignIn, signedInBefore } from './authMarker'
import { clearCloudCache } from './cloud/cache'
import { stopLibrary } from './cloud/library'

export interface AuthUser {
  uid: string
  email: string | null
}

interface AuthState {
  /** null while signed out */
  user: AuthUser | null
  /**
   * false until a saved session has been restored or ruled out: by Firebase where this browser has signed in
   * before (or an older build left a session), otherwise by a quick look on this device (no Firebase loaded)
   */
  ready: boolean
}

const createAuthStore = () => create<AuthState>()(() => ({ user: null, ready: false }))

// Dev only: this module re-runs when a dependency hot-reloads; keep the one store the running
// auth listener writes to, or the header would wait for a session forever.
export const useAuth: ReturnType<typeof createAuthStore> = import.meta.hot?.data?.useAuth ?? createAuthStore()
if (import.meta.hot?.data) import.meta.hot.data.useAuth = useAuth

type AuthSdk = typeof import('firebase/auth')
type LoadedAuth = { auth: Auth; sdk: AuthSdk }

let loading: Promise<LoadedAuth> | null = null

/** Loads the Firebase app + Auth chunks once. A failed load is retried on the next call. */
function loadAuth() {
  loading ??= Promise.all([import('./firebase'), import('firebase/auth')]).then(
    ([{ auth }, sdk]) => ({ auth, sdk }),
    (err: unknown) => {
      loading = null
      console.warn('[auth] Firebase is unavailable', err)
      // surfaces in the dialog as the localized "no connection" message (lib/authErrors.ts)
      throw Object.assign(new Error('Firebase is unavailable'), { code: 'auth/network-request-failed', cause: err })
    },
  )
  return loading
}

let stopMirror: (() => void) | null = null
/** false on the admin page (startAuth): it reads everything through the API and its CSP allows no Firestore (ADR-0002) */
let syncSettings = true

/** How long startup waits for the on-device look for an older build's session (IndexedDB may hang). */
export const LEGACY_LOOKUP_MS = 1500

/**
 * Mirrors Firebase's auth state into `useAuth` (attached once, whoever loaded the SDK first), runs settings
 * sync while signed in and keeps the "signed in before" flag up to date.
 */
function mirror({ auth, sdk }: LoadedAuth): void {
  if (stopMirror) return
  let stopSync: (() => void) | undefined
  let session = 0
  const stopAuth = sdk.onAuthStateChanged(auth, (user) => {
    const before = useAuth.getState().user?.uid ?? null
    // signed out (here, in another tab, the session gone) or someone else signed in: what was kept is not theirs
    if (!user || (before !== null && before !== user.uid)) {
      // synchronously, before the new session is visible: the live list is never shown to the next account
      stopLibrary()
      void clearCloudCache()
    }
    rememberSignIn(!!user)
    useAuth.setState({ user: user && { uid: user.uid, email: user.email }, ready: true })
    stopSync?.()
    stopSync = undefined
    const current = ++session
    if (!user || !syncSettings) return
    import('./settingsSync')
      .then(({ startSettingsSync }) => {
        if (current === session) stopSync = startSettingsSync(user)
      })
      .catch((err: unknown) => console.warn('[settings sync] failed to load', err))
  })
  stopMirror = () => {
    stopMirror = null
    session++
    stopAuth()
    stopSync?.()
  }
}

/** The SDK for an account action; the session is mirrored from then on (e.g. a guest signing in). */
async function accountSdk(): Promise<LoadedAuth> {
  const loaded = await loadAuth()
  mirror(loaded)
  return loaded
}

/**
 * Restores a saved session at startup, only where this browser has signed in before (a guest loads no
 * Firebase), and when another tab signs in. Mount once in App.
 * Without the flag, `ready` waits for the on-device look for a session an older build saved (milliseconds,
 * bounded by LEGACY_LOOKUP_MS): such a user must not look like a guest meanwhile (the guest flows would
 * show, and the API would settle on browser mode before their session is back).
 * `settingsSync: false` (the admin page) signs in without syncing the settings profile.
 */
export function startAuth({ settingsSync = true }: { settingsSync?: boolean } = {}): () => void {
  syncSettings = settingsSync
  let stopped = false
  let lookupTimer: ReturnType<typeof setTimeout> | undefined
  const restore = () =>
    loadAuth().then(
      (loaded) => {
        if (!stopped) mirror(loaded)
      },
      // Firebase unreachable: behave as signed out; the dialog reports the problem if used
      () => {
        if (!stopped) useAuth.setState({ ready: true })
      },
    )
  const ruledOut = () => {
    if (!stopped) useAuth.setState({ ready: true })
  }

  if (signedInBefore()) void restore()
  else {
    lookupTimer = setTimeout(ruledOut, LEGACY_LOOKUP_MS)
    void findLegacySession().then((found) => {
      clearTimeout(lookupTimer)
      if (stopped) return
      // found after the timeout too: the session still comes back (ready stays true meanwhile)
      if (found) void restore()
      else ruledOut()
    })
  }
  const stopElsewhere = onSignInElsewhere(() => {
    if (!stopped) void restore()
  })

  return () => {
    stopped = true
    clearTimeout(lookupTimer)
    stopElsewhere()
    stopMirror?.()
  }
}

export async function signIn(email: string, password: string) {
  const { auth, sdk } = await accountSdk()
  return sdk.signInWithEmailAndPassword(auth, email.trim(), password)
}

export async function signUp(email: string, password: string) {
  const { auth, sdk } = await accountSdk()
  return sdk.createUserWithEmailAndPassword(auth, email.trim(), password)
}

/** Continue-URL errors: the page's host is not one of Auth's authorized domains (e.g. a LAN address). */
const CONTINUE_URL_ERRORS = ['auth/unauthorized-continue-uri', 'auth/invalid-continue-uri', 'auth/missing-continue-uri']

/**
 * The reset email is sent in the app's current language. Its page links back to this app when
 * the current host is an authorized domain (localhost, GitHub Pages); otherwise it is sent without.
 */
export async function sendPasswordReset(email: string) {
  const { auth, sdk } = await accountSdk()
  auth.languageCode = useApp.getState().lang
  const address = email.trim()
  const url = `${window.location.origin}${window.location.pathname}`
  if (!/^https?:/.test(url)) return sdk.sendPasswordResetEmail(auth, address)
  try {
    await sdk.sendPasswordResetEmail(auth, address, { url })
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null
    if (typeof code !== 'string' || !CONTINUE_URL_ERRORS.includes(code)) throw err
    await sdk.sendPasswordResetEmail(auth, address)
  }
}

export async function signOut() {
  const { auth, sdk } = await accountSdk()
  await sdk.signOut(auth)
  rememberSignIn(false)
  stopLibrary()
  await clearCloudCache()
}

/**
 * The signed-in user's Firebase ID token for the cloud API: cached by Firebase and refreshed
 * before it expires (`forceRefresh` = fetch a new one now). Null while signed out.
 */
export async function getIdToken(forceRefresh = false): Promise<string | null> {
  const { auth } = await loadAuth()
  const user = auth.currentUser
  return user ? user.getIdToken(forceRefresh) : null
}

// ------------------------------------------------------------------ account dialog

export type AuthDialogMode = 'signIn' | 'signUp'
/**
 * why the app itself opened the dialog: the session ran out, the action needs an account, or an
 * account would do it better (more precise chords, vocals)
 */
export type AuthDialogReason = 'expired' | 'required' | 'accuracy' | 'vocals' | null

interface AuthDialogState {
  open: boolean
  mode: AuthDialogMode
  reason: AuthDialogReason
  /** bumps on every open, so each open starts with a fresh form */
  session: number
}

const createDialogStore = () =>
  create<AuthDialogState>()(() => ({ open: false, mode: 'signIn', reason: null, session: 0 }))

/** The one account dialog of the app (rendered by components/account/AuthDialogHost). */
export const useAuthDialog: ReturnType<typeof createDialogStore> = import.meta.hot?.data?.useAuthDialog ?? createDialogStore()
if (import.meta.hot?.data) import.meta.hot.data.useAuthDialog = useAuthDialog

let signInWaiters: Array<(signedIn: boolean) => void> = []

/** Opens the account dialog (sign in or sign up). An open dialog stays as it is. */
export function openAuthDialog(mode: AuthDialogMode = 'signIn', reason: AuthDialogReason = null): void {
  const s = useAuthDialog.getState()
  if (s.open) {
    if (reason && !s.reason) useAuthDialog.setState({ reason })
    return
  }
  useAuthDialog.setState({ open: true, mode, reason, session: s.session + 1 })
  // someone is about to sign in: fetch Firebase now (a guest's first load of it), not on submit
  void loadAuth().catch(() => undefined)
}

/**
 * Closes the dialog. Callers waiting in `requestSignIn` learn whether someone is signed in now
 * (`signedIn` = the dialog just signed someone in; otherwise the current session decides).
 */
export function closeAuthDialog(signedIn?: boolean): void {
  if (useAuthDialog.getState().open) useAuthDialog.setState({ open: false, reason: null })
  const waiters = signInWaiters
  signInWaiters = []
  const result = signedIn ?? !!useAuth.getState().user
  waiters.forEach((resolve) => resolve(result))
}

/**
 * Asks the user to sign in (e.g. the cloud rejected the session) and waits: true once signed in,
 * false when the dialog was dismissed.
 */
export function requestSignIn(reason: 'expired' | 'required' = 'required'): Promise<boolean> {
  openAuthDialog('signIn', reason)
  return new Promise((resolve) => signInWaiters.push(resolve))
}
