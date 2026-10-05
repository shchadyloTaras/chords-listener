import { create } from 'zustand'
import * as api from '../../lib/api'
import { toApiError, type ClientErrorCode } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { t } from '../../i18n'
import { useApp } from '../../store'
import type { TrackSummary } from '../../types'
import { useJobs } from '../../hooks/useJobs'

interface TracksState {
  tracks: TrackSummary[] | null
  loading: boolean
  error: ClientErrorCode | null
  /** ids hidden while their delete can still be undone */
  pendingDelete: Record<string, true>
}

export const useTracks = create<TracksState>()(() => ({ tracks: null, loading: false, error: null, pendingDelete: {} }))

let inflight: { promise: Promise<void>; force: boolean } | null = null
let forcedNext: Promise<void> | null = null
/** bumps when the session changes (sign-in, sign-out, another account): a list loaded for the previous one is dropped */
let generation = 0

async function load(force: boolean, gen: number): Promise<void> {
  // the cloud list kept on this device shows at once, whatever its age (lib/cloud/cache)
  if (!force && useTracks.getState().tracks === null) {
    const kept = await api.listCachedTracks()
    if (kept && gen === generation) useTracks.setState({ tracks: kept, error: null })
  }
  const tracks = await api.listTracks(undefined, { force })
  if (gen === generation) useTracks.setState({ tracks, error: null })
}

/**
 * Loads the library: cache-first (the cloud is asked only when the list kept here is stale), or from the
 * server with `force` — a job finished, a track was moved to the cloud, «Оновити».
 */
export function refreshTracks(force = false): Promise<void> {
  if (inflight && (inflight.force || !force)) return inflight.promise
  if (inflight) {
    // a cache-first refresh is on its way: the server is asked right after it
    forcedNext ??= inflight.promise.then(() => {
      forcedNext = null
      return refreshTracks(true)
    })
    return forcedNext
  }
  useTracks.setState({ loading: true })
  const gen = generation
  const promise: Promise<void> = load(force, gen)
    .catch((e) => {
      if (gen === generation) useTracks.setState({ error: toApiError(e).code })
    })
    .finally(() => {
      if (inflight?.promise !== promise) return
      inflight = null
      useTracks.setState({ loading: false })
    })
  inflight = { promise, force }
  return promise
}

// A finished job means a new (or updated) track: ask the server for the list.
useJobs.subscribe((s, prev) => {
  for (const [id, job] of Object.entries(s.jobs)) {
    if (job.status === 'done' && prev.jobs[id]?.status !== 'done') {
      void refreshTracks(true)
      return
    }
  }
})

// Signed in, out, or as someone else: a list on its way was asked for the previous session. After a sign-out
// or another account the list in memory is not theirs either (a guest's own browser tracks stay on screen).
// Another account (e.g. switched in another tab) may keep the same API: nothing else reloads it, so load theirs.
useAuth.subscribe((s, prev) => {
  if ((s.user?.uid ?? null) === (prev.user?.uid ?? null)) return
  generation++
  inflight = null
  useTracks.setState(prev.user ? { tracks: null, error: null, loading: false } : { loading: false })
  if (prev.user && s.user) void refreshTracks()
})

const DELETE_DELAY = 6200
const timers = new Map<string, number>()

function commitDelete(id: string, keepalive = false) {
  timers.delete(id)
  return api
    .deleteTrack(id, { keepalive })
    .catch((e) => {
      const err = toApiError(e)
      if (err.code === 'not_found') return
      useApp.getState().toast(t('core.history.deleteFailed'), 'error')
      throw err
    })
    .then(() => {
      useTracks.setState((s) => ({ tracks: s.tracks?.filter((tr) => tr.id !== id) ?? null }))
    })
    .catch(() => undefined)
    .finally(() => {
      useTracks.setState((s) => {
        const pendingDelete = { ...s.pendingDelete }
        delete pendingDelete[id]
        return { pendingDelete }
      })
    })
}

/** Hides the track right away and deletes it for real unless "Undo" is pressed in time. */
export function scheduleDelete(id: string, title: string) {
  if (timers.has(id)) return
  useTracks.setState((s) => ({ pendingDelete: { ...s.pendingDelete, [id]: true } }))
  timers.set(id, window.setTimeout(() => void commitDelete(id), DELETE_DELAY))
  useApp.getState().toast(t('core.history.deleted', { title }), 'info', {
    label: t('core.undo'),
    run: () => undoDelete(id),
  })
}

export function undoDelete(id: string) {
  const timer = timers.get(id)
  if (timer === undefined) return
  window.clearTimeout(timer)
  timers.delete(id)
  useTracks.setState((s) => {
    const pendingDelete = { ...s.pendingDelete }
    delete pendingDelete[id]
    return { pendingDelete }
  })
}

// Leaving the page: finish pending deletes so "deleted" really means deleted.
window.addEventListener('pagehide', () => {
  for (const [id, timer] of timers) {
    window.clearTimeout(timer)
    void commitDelete(id, true)
  }
})
