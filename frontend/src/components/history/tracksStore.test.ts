// The home page's library: cache-first (the list this device keeps of the cloud library shows at once and is
// asked again only when stale), from the server when something changed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, TrackSummary } from '../../types'

// the store listens for the page going away; settings are persisted
vi.hoisted(() => {
  const data = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, localStorage }))
  vi.stubGlobal('localStorage', localStorage)
})

const api = vi.hoisted(() => ({
  listTracks: vi.fn<(signal?: AbortSignal, opts?: { force?: boolean }) => Promise<TrackSummary[]>>(),
  listCachedTracks: vi.fn<() => Promise<TrackSummary[] | null>>(),
}))

vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), ...api }))

// the session store only (no Firebase)
vi.mock('../../lib/auth', async () => {
  const { create } = await import('zustand')
  return {
    useAuth: create<{ user: { uid: string; email: string | null } | null; ready: boolean }>()(() => ({ user: null, ready: true })),
    getIdToken: async () => null,
    requestSignIn: async () => false,
  }
})

import { useJobs } from '../../hooks/useJobs'
import { ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { isDeleted } from '../../lib/cloud/deleted'
import { useLibrary } from '../../lib/cloud/library'
import { useConnection } from '../../lib/serverMode'
import { refreshTracks, scheduleDelete, useTracks } from './tracksStore'

const song = (id: string): TrackSummary => ({ id, title: id, duration: 1, source: { type: 'file' }, createdAt: '2026-10-05T00:00:00Z' })
const ids = () => useTracks.getState().tracks?.map((t) => t.id) ?? null

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  api.listTracks.mockReset()
  api.listCachedTracks.mockReset().mockResolvedValue(null)
  useTracks.setState({ tracks: null, loading: false, error: null, pendingDelete: {} })
  useAuth.setState({ user: { uid: 'uid42', email: null }, ready: true })
})

afterEach(() => {
  useJobs.setState({ jobs: {} })
  useLibrary.setState({ uid: null, tracks: null, versions: {}, error: false })
  useConnection.setState({ status: 'checking', backend: null, apiBase: null, serverOrigin: null, remote: false })
})

describe('refreshTracks', () => {
  it('shows the list kept on this device at once, then what the server says', async () => {
    api.listCachedTracks.mockResolvedValue([song('a')])
    const server = deferred<TrackSummary[]>()
    api.listTracks.mockReturnValue(server.promise)
    const done = refreshTracks()
    await vi.waitFor(() => expect(ids()).toEqual(['a']))
    expect(api.listTracks).toHaveBeenCalledWith(undefined, { force: false })
    server.resolve([song('b'), song('a')])
    await done
    expect(ids()).toEqual(['b', 'a'])
  })

  it('forced: asks the server', async () => {
    api.listTracks.mockResolvedValue([song('a')])
    await refreshTracks(true)
    expect(api.listCachedTracks).not.toHaveBeenCalled()
    expect(api.listTracks).toHaveBeenCalledWith(undefined, { force: true })
    expect(ids()).toEqual(['a'])
  })

  it('forced while a cache-first refresh runs: asks the server right after it', async () => {
    const first = deferred<TrackSummary[]>()
    api.listTracks.mockReturnValueOnce(first.promise).mockResolvedValueOnce([song('new'), song('a')])
    const cacheFirst = refreshTracks()
    const forced = refreshTracks(true)
    // a second forced one joins it
    expect(refreshTracks(true)).toBe(forced)
    first.resolve([song('a')])
    await cacheFirst
    await forced
    expect(api.listTracks).toHaveBeenCalledTimes(2)
    expect(api.listTracks.mock.calls[1][1]).toEqual({ force: true })
    expect(ids()).toEqual(['new', 'a'])
  })

  it('the server unreachable: the list kept here stays on screen', async () => {
    api.listCachedTracks.mockResolvedValue([song('a')])
    api.listTracks.mockRejectedValue(new ApiError('down', 'network'))
    await refreshTracks()
    expect(ids()).toEqual(['a'])
    expect(useTracks.getState().error).toBe('network')
  })

  it('a finished job asks the server for the new track', async () => {
    api.listTracks.mockResolvedValue([song('a')])
    const job: Job = { id: 'j1', status: 'analyzing', progress: 0.5, message: '', createdAt: '2026-10-05T00:00:00Z' }
    useJobs.setState({ jobs: { j1: job } })
    useJobs.setState({ jobs: { j1: { ...job, status: 'done', trackId: 'a' } } })
    await vi.waitFor(() => expect(api.listTracks).toHaveBeenCalledWith(undefined, { force: true }))
  })

  it('a list on its way for the previous account never shows for the next one', async () => {
    const old = deferred<TrackSummary[]>()
    api.listTracks.mockReturnValueOnce(old.promise).mockResolvedValueOnce([song('theirs')])
    const first = refreshTracks()
    await vi.waitFor(() => expect(api.listTracks).toHaveBeenCalledTimes(1))
    useAuth.setState({ user: { uid: 'other7', email: null } })
    const second = refreshTracks()
    old.resolve([song('mine')])
    await first
    await second
    expect(ids()).toEqual(['theirs'])
    expect(useTracks.getState().loading).toBe(false)
  })

  it('another account signs in, or the user signs out: the list in memory is not theirs', () => {
    useTracks.setState({ tracks: [song('mine')] })
    useAuth.setState({ user: { uid: 'other7', email: null } })
    expect(useTracks.getState().tracks).toBeNull()
    useTracks.setState({ tracks: [song('theirs')] })
    useAuth.setState({ user: null })
    expect(useTracks.getState().tracks).toBeNull()
  })

  it('another account in another tab, on the same cloud (nothing else changes): their list loads', async () => {
    api.listTracks.mockResolvedValue([song('theirs')])
    useTracks.setState({ tracks: [song('mine')] })
    useAuth.setState({ user: { uid: 'other7', email: null } })
    expect(useTracks.getState().tracks).toBeNull()
    await vi.waitFor(() => expect(ids()).toEqual(['theirs']))
  })

  it('a guest signing in keeps their browser tracks on screen meanwhile', () => {
    useAuth.setState({ user: null })
    useTracks.setState({ tracks: [song('local-1')] })
    useAuth.setState({ user: { uid: 'uid42', email: null } })
    expect(ids()).toEqual(['local-1'])
  })
})

describe('the live library (lib/cloud/library)', () => {
  it('its first list, and every change made on another device, shows', async () => {
    useLibrary.setState({ uid: 'uid42', tracks: null, versions: {}, error: false })
    expect(api.listTracks).not.toHaveBeenCalled()
    api.listTracks.mockResolvedValueOnce([song('a')])
    useLibrary.setState({ tracks: [song('a')], versions: { a: 1 } })
    await vi.waitFor(() => expect(ids()).toEqual(['a']))
    api.listTracks.mockResolvedValueOnce([song('b'), song('a')])
    useLibrary.setState({ tracks: [song('b'), song('a')], versions: { a: 1, b: 1 } })
    await vi.waitFor(() => expect(ids()).toEqual(['b', 'a']))
    expect(api.listTracks).toHaveBeenCalledTimes(2)
  })

  it('a failure or anything but a new list asks nothing', async () => {
    const tracks = [song('a')]
    api.listTracks.mockResolvedValue(tracks)
    useLibrary.setState({ uid: 'uid42', tracks, versions: { a: 1 }, error: false })
    await vi.waitFor(() => expect(api.listTracks).toHaveBeenCalledTimes(1))
    useLibrary.setState({ error: true })
    useLibrary.setState({ versions: { a: 1 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(api.listTracks).toHaveBeenCalledTimes(1)
  })

  it('emptied by a sign-out or another account: nothing is loaded for it, the old list never comes back', async () => {
    const old = deferred<TrackSummary[]>()
    api.listTracks.mockReturnValueOnce(old.promise)
    useLibrary.setState({ uid: 'uid42', tracks: [song('mine')], versions: { mine: 1 }, error: false })
    await vi.waitFor(() => expect(api.listTracks).toHaveBeenCalledTimes(1))
    // lib/auth.ts: the library stops first, then the session changes
    useLibrary.setState({ uid: null, tracks: null, versions: {}, error: false })
    useAuth.setState({ user: null })
    old.resolve([song('mine')])
    await new Promise((r) => setTimeout(r, 0))
    expect(api.listTracks).toHaveBeenCalledTimes(1)
    expect(useTracks.getState().tracks).toBeNull()
  })
})

describe('deleting', () => {
  it('leaving the page while it can still be undone: remembered as deleted before the page goes', () => {
    const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
    useConnection.setState({ status: 'server', backend: 'cloud', apiBase: `${CLOUD}/api`, serverOrigin: CLOUD, remote: true })
    const fetchBefore = globalThis.fetch
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined))
    try {
      scheduleDelete('0123456789ab', 'Song')
      expect(isDeleted('uid42', '0123456789ab')).toBe(false)
      window.dispatchEvent(new Event('pagehide'))
      // nothing awaited: the page may be gone the next moment
      expect(isDeleted('uid42', '0123456789ab')).toBe(true)
    } finally {
      globalThis.fetch = fetchBefore
    }
  })
})
