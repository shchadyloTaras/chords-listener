// Server jobs started on this device lately (localStorage, shared by its tabs): a page load asks the server
// for its job list only when one of them may still be running. Every request wakes the cloud (Cloud Run,
// min instances 0), so an idle page asks nothing. Blocked storage: nothing is remembered, nothing breaks.

const KEY = 'chords-listener-server-jobs'
/** A job older than this is not looked for any more. */
const RECENT_MS = 2 * 3600_000
const MAX_JOBS = 20

interface Entry {
  id: string
  /** when it was started (ms) */
  at: number
}

function read(): Entry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is Entry => !!e && typeof e.id === 'string' && typeof e.at === 'number')
  } catch {
    return []
  }
}

function write(list: Entry[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list))
    else localStorage.removeItem(KEY)
  } catch {
    /* storage blocked: a reload simply does not look for the job */
  }
}

/** A server job was started here (a reload picks it up while it runs). */
export function rememberServerJob(id: string): void {
  const now = Date.now()
  const list = read().filter((e) => e.id !== id && now - e.at <= RECENT_MS)
  list.push({ id, at: now })
  write(list.slice(-MAX_JOBS))
}

/** Ids of the server jobs started on this device in the last 2 hours (oldest first, at most 20). */
export function recentServerJobs(now = Date.now()): string[] {
  return read()
    .filter((e) => now - e.at <= RECENT_MS)
    .map((e) => e.id)
}

/** The job is over (done, failed or gone): nothing to look for after a reload. */
export function forgetServerJob(id: string): void {
  const list = read()
  const next = list.filter((e) => e.id !== id)
  if (next.length !== list.length) write(next)
}
