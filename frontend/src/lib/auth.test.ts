// When Firebase is loaded (owner decision: never for a guest until they open the account dialog; at startup
// only in a browser that has signed in before), the "signed in before" flag, and the account dialog's
// sign-in waiters. Firebase itself is mocked: `fb.loads` counts how often its app module was loaded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeUser = { uid: string; email: string | null }

const fb = vi.hoisted(() => {
  const listeners = new Set<(user: FakeUser | null) => void>()
  const state = {
    loads: 0,
    fail: false,
    /** the session Firebase has persisted (restored when the SDK starts) */
    saved: null as FakeUser | null,
    listeners,
    emit(user: FakeUser | null) {
      state.saved = user
      listeners.forEach((fn) => fn(user))
    },
  }
  return state
})

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, fn: (user: FakeUser | null) => void) => {
    fb.listeners.add(fn)
    // like Firebase: the first call reports the restored (or no) session once it is known
    queueMicrotask(() => fn(fb.saved))
    return () => fb.listeners.delete(fn)
  },
  signInWithEmailAndPassword: async (_auth: unknown, email: string) => {
    const user = { uid: 'uid42', email }
    fb.emit(user)
    return { user }
  },
  createUserWithEmailAndPassword: async (_auth: unknown, email: string) => {
    const user = { uid: 'new1', email }
    fb.emit(user)
    return { user }
  },
  signOut: async () => fb.emit(null),
}))

vi.mock('./settingsSync', () => ({ startSettingsSync: () => () => undefined }))

const MARKER = 'chords-listener-auth'
let storage: Map<string, string>

function stubStorage() {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
}

/** A fresh app start: the auth module evaluated anew (its store reads the flag), Firebase not loaded yet. */
async function boot() {
  vi.resetModules()
  vi.doMock('./firebase', () => {
    fb.loads++
    if (fb.fail) throw new Error('blocked by an extension')
    return { auth: { currentUser: null } }
  })
  return import('./auth')
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let stop: (() => void) | undefined

beforeEach(() => {
  fb.loads = 0
  fb.fail = false
  fb.saved = null
  fb.listeners.clear()
  stubStorage()
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a guest (never signed in here)', () => {
  it('is ready and signed out once the on-device look found no session, without loading Firebase', async () => {
    const { startAuth, useAuth } = await boot()
    // not a guest yet: an older build may have left a session (the API must not settle on browser mode)
    expect(useAuth.getState()).toEqual({ user: null, ready: false })
    stop = startAuth()
    await vi.waitFor(() => expect(useAuth.getState()).toEqual({ user: null, ready: true }))
    await settle()
    expect(fb.loads).toBe(0)
    expect(storage.has(MARKER)).toBe(false)
  })

  it('goes on as a guest when the on-device look hangs', async () => {
    vi.stubGlobal('indexedDB', { databases: () => new Promise(() => undefined) })
    const { LEGACY_LOOKUP_MS, startAuth, useAuth } = await boot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      stop = startAuth()
      await vi.advanceTimersByTimeAsync(LEGACY_LOOKUP_MS - 1)
      expect(useAuth.getState().ready).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(useAuth.getState()).toEqual({ user: null, ready: true })
      expect(fb.loads).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads Firebase once the account dialog opens', async () => {
    const { openAuthDialog, closeAuthDialog, startAuth } = await boot()
    stop = startAuth()
    await settle()
    expect(fb.loads).toBe(0)
    openAuthDialog('signUp')
    await vi.waitFor(() => expect(fb.loads).toBe(1))
    closeAuthDialog()
  })

  it('signing in mirrors the session (the cloud follows) and remembers this browser', async () => {
    const { signIn, startAuth, useAuth } = await boot()
    stop = startAuth()
    await signIn(' listener@example.com ', 'secret')
    await vi.waitFor(() => expect(useAuth.getState().user).toEqual({ uid: 'uid42', email: 'listener@example.com' }))
    expect(storage.get(MARKER)).toBe('1')
  })

  it('signing up does the same', async () => {
    const { signUp, useAuth } = await boot()
    await signUp('new@example.com', 'secret')
    await vi.waitFor(() => expect(useAuth.getState().user?.uid).toBe('new1'))
    expect(storage.get(MARKER)).toBe('1')
  })

  it('restores the session when another tab signs in', async () => {
    const win = new EventTarget()
    vi.stubGlobal('window', win)
    const { startAuth, useAuth } = await boot()
    stop = startAuth()
    await settle()
    expect(fb.loads).toBe(0)
    fb.saved = { uid: 'uid42', email: 'listener@example.com' }
    storage.set(MARKER, '1')
    win.dispatchEvent(Object.assign(new Event('storage'), { key: MARKER, newValue: '1' }))
    await vi.waitFor(() => expect(useAuth.getState().user?.uid).toBe('uid42'))
  })

  it('a session saved by an older build (no flag yet) is still restored, never looking like a guest meanwhile', async () => {
    storage.set('firebase:authUser:AIzaSyBL5s4iSoBMrQNIlpYA4WQSjP5tP_4xmUU:[DEFAULT]', '{"uid":"uid42"}')
    fb.saved = { uid: 'uid42', email: 'listener@example.com' }
    const { startAuth, useAuth } = await boot()
    const seen: { user: unknown; ready: boolean }[] = []
    const unsubscribe = useAuth.subscribe((s) => seen.push(s))
    stop = startAuth()
    await vi.waitFor(() => expect(useAuth.getState().user?.uid).toBe('uid42'))
    unsubscribe()
    // ready only together with the restored user (a signed-out "ready" would start the guest flows)
    expect(seen.every((s) => !s.ready || s.user)).toBe(true)
    expect(storage.get(MARKER)).toBe('1')
  })
})

describe('a browser that signed in before', () => {
  beforeEach(() => {
    storage.set(MARKER, '1')
  })

  it('waits for Firebase to restore the session at startup', async () => {
    fb.saved = { uid: 'uid42', email: 'listener@example.com' }
    const { startAuth, useAuth } = await boot()
    expect(useAuth.getState().ready).toBe(false)
    stop = startAuth()
    await vi.waitFor(() => expect(useAuth.getState()).toEqual({ user: { uid: 'uid42', email: 'listener@example.com' }, ready: true }))
    expect(fb.loads).toBe(1)
    expect(storage.get(MARKER)).toBe('1')
  })

  it('forgets the flag when the saved session is gone', async () => {
    const { startAuth, useAuth } = await boot()
    stop = startAuth()
    await vi.waitFor(() => expect(useAuth.getState().ready).toBe(true))
    expect(useAuth.getState().user).toBeNull()
    expect(storage.has(MARKER)).toBe(false)
  })

  it('signing out clears the flag', async () => {
    fb.saved = { uid: 'uid42', email: 'listener@example.com' }
    const { signOut, startAuth, useAuth } = await boot()
    stop = startAuth()
    await vi.waitFor(() => expect(useAuth.getState().user).not.toBeNull())
    await signOut()
    expect(useAuth.getState().user).toBeNull()
    expect(storage.has(MARKER)).toBe(false)
  })

  it('goes on signed out when Firebase cannot be loaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fb.fail = true
    const { startAuth, useAuth } = await boot()
    stop = startAuth()
    await vi.waitFor(() => expect(useAuth.getState().ready).toBe(true))
    expect(useAuth.getState().user).toBeNull()
  })
})

describe('requestSignIn', () => {
  it('resolves true once the dialog signed someone in, false when dismissed', async () => {
    const { closeAuthDialog, requestSignIn, useAuthDialog } = await boot()
    const first = requestSignIn('expired')
    expect(useAuthDialog.getState()).toMatchObject({ open: true, mode: 'signIn', reason: 'expired' })
    closeAuthDialog(true)
    expect(await first).toBe(true)
    expect(useAuthDialog.getState().open).toBe(false)

    const second = requestSignIn()
    closeAuthDialog()
    expect(await second).toBe(false)
  })
})
