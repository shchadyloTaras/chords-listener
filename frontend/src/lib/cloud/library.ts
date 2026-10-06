// The signed-in user's library, live: the API publishes an index document per track to Firestore
// (users/{uid}/tracks/{trackId}, docs/CLOUD.md "Library in Firestore"), and this store follows the collection with one listener, so
// the list and each track's `version` are current without asking the cloud API (any request wakes a Cloud Run
// instance). lib/api.ts reads it while `libraryReady()`. Nothing client-side writes there.
// Started only while the cloud is the API and someone is signed in (lib/cloud/libraryWatch), and stopped and
// emptied synchronously on sign-out or when another account signs in (lib/auth.ts): one account's list is never
// shown to the next. Firestore is loaded on demand, so this module imports nothing from firebase at the top
// level and a guest (who never starts a library) downloads none of it.
import type { DocumentData, Firestore, QuerySnapshot } from 'firebase/firestore'
import { create } from 'zustand'
import type { TrackSummary } from '../../types'

interface LibraryState {
  /** the account being followed; null while stopped */
  uid: string | null
  /** newest first; null until the listener first answers */
  tracks: TrackSummary[] | null
  /** published version of each listed track (changes whenever the track does) */
  versions: Record<string, number>
  /** the listener failed (rules, network, SDK did not load): `tracks` is the last list seen, if any */
  error: boolean
}

const idle = (): LibraryState => ({ uid: null, tracks: null, versions: {}, error: false })

export const useLibrary = create<LibraryState>()(idle)

/** The list is there and current as of the listener's last answer (no error). */
export function libraryReady(): boolean {
  const { tracks, error } = useLibrary.getState()
  return tracks !== null && !error
}

/** Bumped by every start and stop: work that was begun for an older number must not touch the store. */
let generation = 0
let unsubscribe: (() => void) | null = null

/** An index document: the API's TrackSummary fields + `version`, and `publishedAt` (a Firestore timestamp), which is dropped. */
function toSummary(id: string, data: DocumentData): TrackSummary {
  const { publishedAt: _publishedAt, ...summary } = data
  return { ...summary, id } as TrackSummary
}

function apply(snap: QuerySnapshot): void {
  // Offline with nothing cached Firestore answers "empty" from the cache: that is not the library being empty.
  // The server's own answer follows (metadata changes are listened to for exactly this).
  if (snap.empty && snap.metadata.fromCache) return
  // Only the metadata changed (online ↔ offline, cache ↔ server): the same list. Not written, so readers that
  // follow `tracks` (components/history/tracksStore) are not woken by every connectivity blip.
  if (useLibrary.getState().tracks !== null && snap.docChanges().length === 0) return
  const tracks = snap.docs.map((d) => toSummary(d.id, d.data()))
  const versions: Record<string, number> = {}
  for (const t of tracks) if (typeof t.version === 'number') versions[t.id] = t.version
  useLibrary.setState({ tracks, versions, error: false })
}

function fail(err: unknown): void {
  if (!useLibrary.getState().error) console.warn('[library]', err)
  useLibrary.setState({ error: true })
}

let loading: Promise<{ sdk: typeof import('firebase/firestore'); db: Firestore }> | null = null

/** Loads the Firestore SDK and the app's instance once. A failed load is tried again by the next start. */
function loadFirestore() {
  loading ??= Promise.all([import('firebase/firestore'), import('../firestore')]).then(
    ([sdk, { db }]) => ({ sdk, db }),
    (err: unknown) => {
      loading = null
      throw err
    },
  )
  return loading
}

async function attach(uid: string, mine: number): Promise<void> {
  try {
    const { sdk, db } = await loadFirestore()
    // stopped, or another account started, while Firestore was loading
    if (mine !== generation) return
    unsubscribe = sdk.onSnapshot(
      sdk.query(sdk.collection(db, 'users', uid, 'tracks'), sdk.orderBy('createdAt', 'desc')),
      { includeMetadataChanges: true },
      (snap) => {
        if (mine === generation) apply(snap)
      },
      (err) => {
        if (mine === generation) fail(err)
      },
    )
  } catch (err) {
    if (mine === generation) fail(err)
  }
}

/** Follows `uid`'s library from now on, replacing whatever was followed. Asked again for the same account: nothing happens. */
export function startLibrary(uid: string): void {
  if (useLibrary.getState().uid === uid) return
  stopLibrary()
  const mine = generation
  useLibrary.setState({ ...idle(), uid })
  void attach(uid, mine)
}

/** Stops following and empties the store, synchronously. */
export function stopLibrary(): void {
  generation++
  unsubscribe?.()
  unsubscribe = null
  const s = useLibrary.getState()
  if (s.uid !== null || s.tracks !== null || s.error) useLibrary.setState(idle())
}
