// Cloud tracks deleted on this device lately (localStorage, shared by its tabs, per account), so nothing kept
// here (lib/cloud/cache) and no list answer that set off before the delete brings one back. Written before
// anything is awaited: a page closed during the undo window sends the DELETE with keepalive, but its IndexedDB
// write may never happen. A track stays hidden until a list asked after the delete no longer has it, a list
// asked after the cloud confirmed the delete lists it again (added again: track ids come from the content, so
// the same file gets the same id), the same id comes out of a finished job, or DELETED_TTL_MS. Blocked
// storage: nothing is remembered, nothing breaks.

const KEY = 'chords-listener-deleted-tracks'
/** A deleted track is hidden for this long at most. */
export const DELETED_TTL_MS = 7 * 24 * 3600_000
const MAX_ENTRIES = 200

interface Entry {
  uid: string
  id: string
  /** when it was deleted here (ms) */
  at: number
  /** when the cloud said it is gone (ms): what is asked after that is the truth again */
  done?: number
}

function read(now = Date.now()): Entry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is Entry =>
        !!e && typeof e.uid === 'string' && typeof e.id === 'string' && typeof e.at === 'number' && now - e.at <= DELETED_TTL_MS,
    )
  } catch {
    return []
  }
}

function write(list: Entry[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)))
    else localStorage.removeItem(KEY)
  } catch {
    /* storage blocked: only the device cache's own forgetting is left */
  }
}

const isOf = (e: Entry, uid: string, id: string) => e.uid === uid && e.id === id

/** The track is being deleted (synchronous: call it before awaiting anything). */
export function rememberDeleted(uid: string, id: string): void {
  const list = read().filter((e) => !isOf(e, uid, id))
  list.push({ uid, id, at: Date.now() })
  write(list)
}

/** The cloud said the track is gone (the DELETE went through, or it answered 404). */
export function deleteConfirmed(uid: string, id: string): void {
  const list = read()
  const entry = list.find((e) => isOf(e, uid, id))
  if (!entry || entry.done) return
  entry.done = Date.now()
  write(list)
}

/** The track is not deleted after all (the cloud refused the delete) or exists again (a job made it again). */
export function forgetDeleted(uid: string, id: string): void {
  const list = read()
  const next = list.filter((e) => !isOf(e, uid, id))
  if (next.length !== list.length) write(next)
}

export function isDeleted(uid: string, id: string): boolean {
  return read().some((e) => isOf(e, uid, id))
}

/** `tracks` (kept on this device) without the ones deleted here. */
export function withoutDeleted<T extends { id: string }>(uid: string, tracks: T[]): T[] {
  const gone = new Set(read().flatMap((e) => (e.uid === uid ? [e.id] : [])))
  return gone.size ? tracks.filter((t) => !gone.has(t.id)) : tracks
}

/**
 * A list the cloud just sent, asked at `askedAt`, without the tracks deleted here; it also settles what it can
 * tell about: a delete it shows went through, or a track listed again after the cloud confirmed its delete.
 */
export function settleDeleted<T extends { id: string }>(uid: string, tracks: T[], askedAt: number): T[] {
  const list = read()
  if (!list.some((e) => e.uid === uid)) return tracks
  const listed = new Set(tracks.map((t) => t.id))
  const hidden = new Set<string>()
  const next = list.filter((e) => {
    if (e.uid !== uid) return true
    if (e.done !== undefined && askedAt > e.done) return false
    if (askedAt > e.at && !listed.has(e.id)) return false
    hidden.add(e.id)
    return true
  })
  if (next.length !== list.length) write(next)
  return hidden.size ? tracks.filter((t) => !hidden.has(t.id)) : tracks
}

/** Sign-out, another account: what was kept goes, so does this. */
export function clearDeleted(): void {
  write([])
}
