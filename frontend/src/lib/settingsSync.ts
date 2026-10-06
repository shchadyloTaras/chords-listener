// Firestore profile + settings sync for the signed-in user (users/{uid}, see /firestore.rules).
// Imported lazily from lib/auth.ts on sign-in, so signed-out visitors never download Firestore.
import type { User } from 'firebase/auth'
import { doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { t } from '../i18n'
import { useApp } from '../store'
import { db } from './firestore'
import { parseSynced, pickSynced, syncedChanged, syncedKey, SYNCED_KEYS, type SyncedKey, type SyncedSettings } from './syncedSettings'

/** Batches rapid toggles (e.g. cycling instruments) into one write. */
const WRITE_DELAY_MS = 800

/**
 * The profile's settings win on sign-in (except keys changed on this device while it was
 * loading, e.g. offline); afterwards local changes are pushed (debounced) and changes made on
 * other devices arrive live. A first sign-in creates the profile from this device's
 * preferences. Offline, nothing is written until the server has been reached. Returns a stop
 * function.
 */
export function startSettingsSync(user: User): () => void {
  const ref = doc(db, 'users', user.uid)
  /** The server's settings as last read or written; null until the profile has loaded. */
  let remote: SyncedSettings | null = null
  /** Synced keys changed locally before the profile loaded. */
  const editedWhileLoading = new Set<SyncedKey>()
  let creating = false
  let applying = false
  let timer = 0
  let reported = false

  const report = (err: unknown) => {
    console.warn('[settings sync]', err)
    if (!reported) useApp.getState().toast(t('account.syncError'), 'error')
    reported = true
  }

  const push = () => {
    timer = 0
    if (!remote) return
    const settings = pickSynced(useApp.getState(), remote)
    if (syncedKey(settings) === syncedKey(remote)) return
    remote = settings
    updateDoc(ref, { email: user.email, settings, updatedAt: serverTimestamp() }).catch(report)
  }

  const schedulePush = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(push, WRITE_DELAY_MS)
  }

  const stopSnapshot = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        // Offline with nothing cached: the profile may exist but be unreachable, so wait for the
        // server instead of overwriting it.
        if (snap.metadata.fromCache || creating) return
        creating = true
        editedWhileLoading.clear()
        const settings = pickSynced(useApp.getState())
        remote = settings
        setDoc(ref, {
          email: user.email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          settings,
        }).catch(report)
        return
      }
      // our own write echoing back, or a local edit about to be pushed: local wins
      if (snap.metadata.hasPendingWrites || timer) return
      const incoming = parseSynced(snap.get('settings'))
      if (remote && syncedKey(incoming) === syncedKey(remote)) return
      const apply: Partial<SyncedSettings> = { ...incoming }
      for (const k of editedWhileLoading) delete apply[k]
      editedWhileLoading.clear()
      applying = true
      useApp.setState(apply)
      applying = false
      remote = { ...pickSynced(useApp.getState()), ...incoming }
      if (syncedKey(pickSynced(useApp.getState(), remote)) !== syncedKey(remote)) schedulePush()
    },
    report,
  )

  const stopStore = useApp.subscribe((s, prev) => {
    if (applying || !syncedChanged(s, prev)) return
    if (remote === null) {
      for (const k of SYNCED_KEYS) if (s[k] !== prev[k]) editedWhileLoading.add(k)
      return
    }
    schedulePush()
  })

  return () => {
    window.clearTimeout(timer)
    stopSnapshot()
    stopStore()
  }
}
