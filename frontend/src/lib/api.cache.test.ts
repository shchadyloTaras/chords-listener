// The signed-in user's cloud library kept on this device (lib/cloud/cache, on fake-indexeddb): the API client
// answers from it without asking the cloud, keeps it in step with edits / deletes / finished jobs, and never
// keeps anything for a local server, a guest or another account.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Track, TrackNotes } from '../types'

const auth = vi.hoisted(() => ({
  user: { uid: 'uid42', email: 'listener@example.com' } as { uid: string; email: string | null } | null,
}))

vi.mock('./auth', () => ({
  getIdToken: async () => 'token-1',
  requestSignIn: async () => false,
  useAuth: { getState: () => ({ user: auth.user, ready: true }), subscribe: () => () => undefined },
}))

import * as api from './api'
import { rememberServerJob } from './cloud/activity'
import { cachedAudio, cachedList, cachedTrack, LIST_TTL_MS, saveTrack, TRACK_TTL_MS } from './cloud/cache'
import { DELETED_TTL_MS } from './cloud/deleted'
import { createMemoryRepo, setLocalRepo } from './local'
import { useConnection, type ConnectionState } from './serverMode'

const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
const ID = '0123456789ab'
const fetchMock = vi.fn<typeof fetch>()

function connect(patch: Partial<ConnectionState>) {
  useConnection.setState({ probing: false, failure: null, checkedAt: 1, health: null, permission: 'unsupported', ...patch })
}

const cloud = () => connect({ status: 'server', backend: 'cloud', apiBase: `${CLOUD}/api`, serverOrigin: CLOUD, remote: true })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const audioPath = (sig: string) => `/api/tracks/${ID}/audio?u=uid42&exp=1790000000&sig=${sig}`

function cloudTrack(patch: Partial<Track> = {}): Track {
  return {
    id: ID,
    title: 'Cloud song',
    duration: 10,
    source: { type: 'file', filename: 'song.mp3' },
    createdAt: '2026-10-04T10:00:00Z',
    audioUrl: audioPath('old'),
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
    ...patch,
  }
}

const summary = (id: string, createdAt = '2026-10-04T10:00:00Z') => ({
  id,
  title: `Song ${id}`,
  duration: 10,
  source: { type: 'file', filename: 'a.mp3' },
  createdAt,
})

const urls = () => fetchMock.mock.calls.map(([url]) => String(url))

/** How GET /tracks lists a track (the summary fields of GET /tracks/{id}). */
const listedAs = (t: Track) => ({ id: t.id, title: t.title, duration: t.duration, source: t.source, createdAt: t.createdAt })

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
  setLocalRepo(createMemoryRepo())
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  // the hosted page (media URLs are resolved against it)
  vi.stubGlobal('location', new URL('https://shchadylotaras.github.io/chords-listener/'))
  auth.user = { uid: 'uid42', email: 'listener@example.com' }
  cloud()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setLocalRepo(null)
  connect({ status: 'checking', backend: null, apiBase: null, serverOrigin: null, remote: false })
})

describe('the library list', () => {
  it('is asked once, then comes from this device until it is LIST_TTL_MS old', async () => {
    fetchMock.mockImplementation(async () => json([summary('a')]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + LIST_TTL_MS)
    await api.listTracks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('is asked again when forced (a job finished, «Оновити»)', async () => {
    fetchMock.mockImplementation(async () => json([summary('a')]))
    await api.listTracks()
    await api.listTracks(undefined, { force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('kept here shows at any age; nothing when it was never listed', async () => {
    expect(await api.listCachedTracks()).toBeNull()
    fetchMock.mockResolvedValueOnce(json([summary('a')]))
    await api.listTracks()
    vi.setSystemTime(Date.now() + 24 * 3600_000)
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual(['a'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolves URLs against the cloud also when it comes from this device', async () => {
    fetchMock.mockResolvedValueOnce(json([{ ...summary('a'), thumbnail: '/api/tracks/a/thumb?sig=1' }]))
    await api.listTracks()
    const [kept] = await api.listTracks()
    expect(kept.thumbnail).toBe(`${CLOUD}/api/tracks/a/thumb?sig=1`)
  })

  it('the cloud unreachable: the list kept here, however old', async () => {
    fetchMock.mockResolvedValueOnce(json([summary('a')]))
    await api.listTracks()
    vi.setSystemTime(Date.now() + LIST_TTL_MS + 1)
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
  })

  it('a song finished while the page was away (a job started here) is asked for', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    rememberServerJob('job9')
    fetchMock.mockResolvedValueOnce(json([summary('a')]))
    await api.listTracks()
    // the page comes back: the job list says it is done
    const finished: Job = { id: 'job9', status: 'done', progress: 1, message: 'Done', trackId: 'new1', createdAt: '2026-10-05T11:00:00Z' }
    fetchMock.mockResolvedValueOnce(json([finished]))
    await api.listJobs()
    // the kept list still shows at once, but is asked again
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual(['a'])
    fetchMock.mockResolvedValueOnce(json([summary('new1', '2026-10-05T11:00:00Z'), summary('a')]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['new1', 'a'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a job seen finishing makes the list kept here old', async () => {
    fetchMock.mockResolvedValueOnce(json([summary('a')]))
    await api.listTracks()
    const job: Job = { id: 'job1', status: 'done', progress: 1, message: 'Done', trackId: 'new1', createdAt: '2026-10-05T11:00:00Z' }
    fetchMock.mockResolvedValueOnce(json(job))
    await api.getJob('job1')
    fetchMock.mockResolvedValueOnce(json([summary('new1'), summary('a')]))
    await api.listTracks()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a list answer squares the tracks kept here with it (renamed or deleted on another device)', async () => {
    const B = '0123456789bb'
    const C = '0123456789cc'
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack()), listedAs(cloudTrack({ id: B })), listedAs(cloudTrack({ id: C }))]))
    await api.listTracks()
    for (const id of [ID, B, C]) {
      fetchMock.mockResolvedValueOnce(json(cloudTrack({ id })))
      await api.getTrack(id)
    }
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['b'])))
    await api.fetchTrackAudio({ id: B, audioUrl: `${CLOUD}/api/tracks/${B}/audio?sig=1` })
    expect(fetchMock).toHaveBeenCalledTimes(5)

    // «Оновити»: ID was renamed elsewhere, B deleted elsewhere, C is as it was
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack({ title: 'Renamed elsewhere' })), listedAs(cloudTrack({ id: C }))]))
    await api.listTracks(undefined, { force: true })
    expect(await cachedTrack('uid42', B)).toBeNull()
    expect(await cachedAudio('uid42', B)).toBeNull()
    expect(await cachedTrack('uid42', C)).not.toBeNull()
    fetchMock.mockResolvedValueOnce(json(cloudTrack({ title: 'Renamed elsewhere' })))
    expect((await api.getTrack(ID)).title).toBe('Renamed elsewhere')
    await api.getTrack(C)
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('is never kept for a local server', async () => {
    connect({ status: 'server', backend: 'local', apiBase: 'http://localhost:8765/api', serverOrigin: 'http://localhost:8765', remote: true })
    fetchMock.mockImplementation(async () => json([summary('a')]))
    await api.listTracks()
    await api.listTracks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await cachedList('uid42')).toBeNull()
    expect(await api.listCachedTracks()).toBeNull()
  })

  it('is never kept without a signed-in user', async () => {
    auth.user = null
    fetchMock.mockImplementation(async () => json([summary('a')]))
    await api.listTracks()
    await api.listTracks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('another account on this browser never sees the first one’s', async () => {
    fetchMock.mockResolvedValueOnce(json([summary('mine')]))
    await api.listTracks()
    auth.user = { uid: 'other7', email: 'other@example.com' }
    expect(await api.listCachedTracks()).toBeNull()
    fetchMock.mockResolvedValueOnce(json([summary('theirs')]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['theirs'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('a track', () => {
  it('opens from this device the second time, until TRACK_TTL_MS', async () => {
    fetchMock.mockImplementation(async () => json(cloudTrack()))
    await api.getTrack(ID)
    const again = await api.getTrack(ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // the signed URL as the server gave it, resolved against the cloud
    expect(again.audioUrl).toBe(`${CLOUD}${audioPath('old')}`)
    vi.setSystemTime(Date.now() + TRACK_TTL_MS)
    await api.getTrack(ID)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an edit is kept, in the track and in the list', async () => {
    fetchMock.mockResolvedValueOnce(json([summary(ID)]))
    await api.listTracks()
    fetchMock.mockResolvedValueOnce(json(cloudTrack({ title: 'Renamed', edited: true })))
    await api.updateTrack(ID, { title: 'Renamed' })
    expect((await api.getTrack(ID)).title).toBe('Renamed')
    expect((await api.listTracks())[0]).toMatchObject({ title: 'Renamed', edited: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(json(cloudTrack({ title: 'Renamed', edited: false })))
    await api.resetTrack(ID)
    expect((await api.listTracks())[0].edited).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a delete forgets it everywhere', async () => {
    fetchMock.mockResolvedValueOnce(json([summary(ID), summary('b')]))
    await api.listTracks()
    fetchMock.mockResolvedValueOnce(json(cloudTrack()))
    await api.getTrack(ID)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.deleteTrack(ID)
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['b'])
    expect(await cachedTrack('uid42', ID)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a finished re-analysis or vocals job: the track is asked again next time, still listed', async () => {
    fetchMock.mockResolvedValueOnce(json([summary(ID)]))
    await api.listTracks()
    fetchMock.mockResolvedValueOnce(json(cloudTrack()))
    await api.getTrack(ID)
    const job: Job = { id: 'job1', kind: 'vocals', status: 'done', progress: 1, message: 'Done', trackId: ID, createdAt: '2026-10-05T00:00:00Z' }
    fetchMock.mockResolvedValueOnce(json(job))
    await api.getJob('job1')
    expect(await cachedTrack('uid42', ID)).toBeNull()
    expect((await cachedList('uid42'))?.tracks.map((t) => t.id)).toEqual([ID])
    fetchMock.mockResolvedValueOnce(json(cloudTrack({ vocals: true })))
    expect((await api.getTrack(ID)).vocals).toBe(true)
  })

  it('a local server’s track is never kept', async () => {
    connect({ status: 'server', backend: 'local', apiBase: 'http://localhost:8765/api', serverOrigin: 'http://localhost:8765', remote: true })
    fetchMock.mockImplementation(async () => json(cloudTrack()))
    await api.getTrack(ID)
    await api.getTrack(ID)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await cachedTrack('uid42', ID)).toBeNull()
  })
})

describe('a deleted track never comes back from this device', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))

  /** Listed, opened and played here: everything of it is kept. */
  async function keptEverywhere() {
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack()), summary('b')]))
    await api.listTracks()
    fetchMock.mockResolvedValueOnce(json(cloudTrack()))
    await api.getTrack(ID)
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['mp3'])))
    await api.fetchTrackAudio({ id: ID, audioUrl: `${CLOUD}${audioPath('old')}` })
    fetchMock.mockClear()
  }

  it('deleted as the page closed (the DELETE goes out, the IndexedDB write is lost): not listed, not opened from here', async () => {
    await keptEverywhere()
    // pagehide: the request leaves with keepalive, the page is gone before IndexedDB does anything
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => undefined))
    const factory = globalThis.indexedDB
    Reflect.deleteProperty(globalThis, 'indexedDB')
    void api.deleteTrack(ID, { keepalive: true })
    globalThis.indexedDB = factory
    expect(await cachedTrack('uid42', ID)).not.toBeNull()

    // the next visit
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual(['b'])
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['b'])
    fetchMock.mockResolvedValueOnce(json({ detail: 'Track not found', code: 'not_found' }, 404))
    await expect(api.getTrack(ID)).rejects.toMatchObject({ code: 'not_found' })
    expect(urls()).toEqual([`${CLOUD}/api/tracks/${ID}`, `${CLOUD}/api/tracks/${ID}`])
    // the cloud says it is gone: nothing of it stays here
    expect(await cachedTrack('uid42', ID)).toBeNull()
    expect(await cachedAudio('uid42', ID)).toBeNull()
    expect((await cachedList('uid42'))?.tracks.map((t) => t.id)).toEqual(['b'])
  })

  it('a list on its way when the delete went through does not bring it back', async () => {
    await keptEverywhere()
    vi.setSystemTime(Date.now() + LIST_TTL_MS)
    let answer!: (res: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)))
    const late = api.listTracks()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.deleteTrack(ID)
    // asked before the delete: still lists it
    answer(json([listedAs(cloudTrack()), summary('b')]))
    expect((await late).map((t) => t.id)).toEqual(['b'])
    expect((await cachedList('uid42'))?.tracks.map((t) => t.id)).toEqual(['b'])
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual(['b'])
  })

  it('deleted on another device: opening it forgets what is kept of it, the list too', async () => {
    fetchMock.mockResolvedValueOnce(json([summary(ID), summary('b')]))
    await api.listTracks()
    vi.setSystemTime(Date.now() + TRACK_TTL_MS)
    fetchMock.mockResolvedValueOnce(json({ detail: 'Track not found', code: 'not_found' }, 404))
    await expect(api.getTrack(ID)).rejects.toMatchObject({ code: 'not_found' })
    expect((await cachedList('uid42'))?.tracks.map((t) => t.id)).toEqual(['b'])
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual(['b'])
  })

  it('the same song added again (same id) shows again', async () => {
    await keptEverywhere()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.deleteTrack(ID)
    // the same file uploaded again: the server gives it the same id
    const job: Job = { id: 'job2', status: 'done', progress: 1, message: 'Done', trackId: ID, createdAt: '2026-10-05T12:00:00Z' }
    fetchMock.mockResolvedValueOnce(json(job))
    await api.getJob('job2')
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack()), summary('b')]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual([ID, 'b'])
  })

  it('added again on another device after the delete went through: the next list shows it', async () => {
    await keptEverywhere()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.deleteTrack(ID)
    vi.setSystemTime(Date.now() + 1000)
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack()), summary('b')]))
    expect((await api.listTracks(undefined, { force: true })).map((t) => t.id)).toEqual([ID, 'b'])
  })

  it('a delete the cloud refused: the track is still there and shows', async () => {
    await keptEverywhere()
    fetchMock.mockResolvedValueOnce(json({ detail: 'Busy', code: 'internal' }, 500))
    await expect(api.deleteTrack(ID)).rejects.toMatchObject({ code: 'internal' })
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual([ID, 'b'])
    expect((await api.getTrack(ID)).id).toBe(ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('remembered for DELETED_TTL_MS at most', async () => {
    await keptEverywhere()
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => undefined))
    void api.deleteTrack(ID, { keepalive: true })
    // the delete never arrived: the cloud keeps listing it
    vi.setSystemTime(Date.now() + LIST_TTL_MS)
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack()), summary('b')]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['b'])
    vi.setSystemTime(Date.now() + DELETED_TTL_MS)
    fetchMock.mockResolvedValueOnce(json([listedAs(cloudTrack()), summary('b')]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual([ID, 'b'])
  })
})

describe('the audio', () => {
  it('is downloaded once, then comes from this device', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['mp3'])))
    const track = { id: ID, audioUrl: `${CLOUD}${audioPath('old')}` }
    expect(await (await api.fetchTrackAudio(track)).text()).toBe('mp3')
    expect(await (await api.fetchTrackAudio(track)).text()).toBe('mp3')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await cachedAudio('uid42', ID)).not.toBeNull()
  })

  it('expired signed URL: the cached track is forgotten, asked again once, and its new URL plays', async () => {
    // opened a while ago: the track (with its signed URL) is on this device
    await saveTrack('uid42', cloudTrack())
    const track = await api.getTrack(ID)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock
      .mockResolvedValueOnce(json({ detail: 'Link expired', code: 'unauthorized' }, 401))
      .mockResolvedValueOnce(json(cloudTrack({ audioUrl: audioPath('new') })))
      .mockResolvedValueOnce(new Response(new Blob(['mp3'])))
    expect(await (await api.fetchTrackAudio(track)).text()).toBe('mp3')
    expect(urls()).toEqual([`${CLOUD}${audioPath('old')}`, `${CLOUD}/api/tracks/${ID}`, `${CLOUD}${audioPath('new')}`])
    // the fresh track is kept from now on
    expect((await api.getTrack(ID)).audioUrl).toBe(`${CLOUD}${audioPath('new')}`)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('refused again after the fresh URL: gives up (no loop)', async () => {
    await saveTrack('uid42', cloudTrack())
    const track = await api.getTrack(ID)
    fetchMock
      .mockResolvedValueOnce(json({ detail: 'Link expired', code: 'unauthorized' }, 401))
      .mockResolvedValueOnce(json(cloudTrack({ audioUrl: audioPath('new') })))
      .mockResolvedValueOnce(json({ detail: 'Link expired', code: 'unauthorized' }, 401))
    await expect(api.fetchTrackAudio(track)).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await cachedAudio('uid42', ID)).toBeNull()
  })

  it('a stem is not the track’s audio: never served from or kept as it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['mix'])))
    await api.fetchTrackAudio({ id: ID, audioUrl: `${CLOUD}${audioPath('old')}` })
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['stem'])))
    expect(await (await api.fetchMedia(`${CLOUD}/api/tracks/${ID}/stems/vocals?sig=1`)).text()).toBe('stem')
    expect(await (await api.fetchTrackAudio({ id: ID, audioUrl: 'unused' })).text()).toBe('mix')
  })
})

describe('the live-piano notes', () => {
  const notes: TrackNotes = { version: 1, engine: 'basic-pitch', notes: [[0, 1, 60, 0.9]] }

  it('are asked once, then come from this device', async () => {
    fetchMock.mockResolvedValueOnce(json(notes))
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('saved ones are kept too; missing ones are asked again', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'none', code: 'not_found' }, 404))
    expect(await api.getTrackNotes(ID)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.saveTrackNotes(ID, notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
