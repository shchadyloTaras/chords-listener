// Firebase Auth (email/password): session state for the UI + account actions.
// Signing in is optional and only syncs settings (lib/settingsSync.ts); the /api backend
// never sees the account. Firebase is loaded on demand into separate chunks, so a blocked
// or unreachable Firebase only disables the account button's features, never the app.
import type { Auth } from 'firebase/auth'
import { create } from 'zustand'
import { useApp } from '../store'

export interface AuthUser {
  uid: string
  email: string | null
}

interface AuthState {
  /** null while signed out */
  user: AuthUser | null
  /** false until Firebase has restored (or ruled out) a persisted session */
  ready: boolean
}

const createAuthStore = () => create<AuthState>()(() => ({ user: null, ready: false }))

// Dev only: this module re-runs when a dependency hot-reloads; keep the one store the running
// auth listener writes to, or the header would wait for a session forever.
export const useAuth: ReturnType<typeof createAuthStore> = import.meta.hot?.data.useAuth ?? createAuthStore()
if (import.meta.hot) import.meta.hot.data.useAuth = useAuth

type AuthSdk = typeof import('firebase/auth')

let loading: Promise<{ auth: Auth; sdk: AuthSdk }> | null = null

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

/** Mirrors Firebase's auth state into `useAuth` and runs settings sync while signed in. Mount once in App. */
export function startAuth(): () => void {
  let stopped = false
  let stopAuth: (() => void) | undefined
  let stopSync: (() => void) | undefined
  let session = 0

  loadAuth().then(
    ({ auth, sdk }) => {
      if (stopped) return
      stopAuth = sdk.onAuthStateChanged(auth, (user) => {
        useAuth.setState({ user: user && { uid: user.uid, email: user.email }, ready: true })
        stopSync?.()
        stopSync = undefined
        const current = ++session
        if (!user) return
        import('./settingsSync')
          .then(({ startSettingsSync }) => {
            if (current === session && !stopped) stopSync = startSettingsSync(user)
          })
          .catch((err: unknown) => console.warn('[settings sync] failed to load', err))
      })
    },
    // Firebase unreachable: behave as signed out; the dialog reports the problem if used
    () => {
      if (!stopped) useAuth.setState({ ready: true })
    },
  )

  return () => {
    stopped = true
    session++
    stopAuth?.()
    stopSync?.()
  }
}

export async function signIn(email: string, password: string) {
  const { auth, sdk } = await loadAuth()
  return sdk.signInWithEmailAndPassword(auth, email.trim(), password)
}

export async function signUp(email: string, password: string) {
  const { auth, sdk } = await loadAuth()
  return sdk.createUserWithEmailAndPassword(auth, email.trim(), password)
}

/** Continue-URL errors: the page's host is not one of Auth's authorized domains (e.g. a LAN address). */
const CONTINUE_URL_ERRORS = ['auth/unauthorized-continue-uri', 'auth/invalid-continue-uri', 'auth/missing-continue-uri']

/**
 * The reset email is sent in the app's current language. Its page links back to this app when
 * the current host is an authorized domain (localhost, GitHub Pages); otherwise it is sent without.
 */
export async function sendPasswordReset(email: string) {
  const { auth, sdk } = await loadAuth()
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
  const { auth, sdk } = await loadAuth()
  await sdk.signOut(auth)
}
