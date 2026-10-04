import { create } from 'zustand'
import * as api from '../../lib/api'
import { toApiError, type ClientErrorCode } from '../../lib/api'
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

let inflight: Promise<void> | null = null

export function refreshTracks(): Promise<void> {
  if (inflight) return inflight
  useTracks.setState({ loading: true })
  inflight = api
    .listTracks()
    .then((tracks) => useTracks.setState({ tracks, error: null }))
    .catch((e) => useTracks.setState({ error: toApiError(e).code }))
    .finally(() => {
      useTracks.setState({ loading: false })
      inflight = null
    })
  return inflight
}

// A finished job means a new (or updated) track: refresh the list.
useJobs.subscribe((s, prev) => {
  for (const [id, job] of Object.entries(s.jobs)) {
    if (job.status === 'done' && prev.jobs[id]?.status !== 'done') {
      void refreshTracks()
      return
    }
  }
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
