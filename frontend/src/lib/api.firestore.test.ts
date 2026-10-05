// The signed-in user's library read without waking the cloud API: the list from the live Firestore index
// (lib/cloud/library — set here directly), track data, notes and vocal notes from Storage (lib/cloud/files —
// mocked), each kept on the device while its version is the index's. Every gap (index not there or failed,
// a file missing or unreadable) takes the API path, and the app behaves as before.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track, TrackNotes, TrackSummary, VocalNotes } from '../types'
import type { TrackFile } from './cloud/files'

const auth = vi.hoisted(() => ({
  user: { uid: 'uid42', email: 'listener@example.com' } as { uid: string; email: string | null } | null,
}))

vi.mock('./auth', () => ({
  getIdToken: async () => 'token-1',
  requestSignIn: async () => false,
  useAuth: { getState: () => ({ user: auth.user, ready: true }), subscribe: () => () => undefined },
}))

const trouble = vi.hoisted(() => ({ noteServerTrouble: vi.fn() }))

// a network failure re-probes the server (see api.cache.test.ts); here it is only counted
vi.mock('./serverMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serverMode')>()),
  noteServerTrouble: trouble.noteServerTrouble,
}))

const files = vi.hoisted(() => ({
  readTrackFile: vi.fn<(uid: string, id: string) => Promise<TrackFile | null>>(),
  readJsonFile: vi.fn<(uid: string, id: string, name: 'notes.json' | 'vocals.json') => Promise<unknown>>(),
}))

vi.mock('./cloud/files', async (importOriginal) => ({ ...(await importOriginal<typeof import('./cloud/files')>()), ...files }))

import * as api from './api'
import { cachedAudio, cachedList, cachedTrack, cachedTrackAt, saveList, saveTrack, TRACK_TTL_MS } from './cloud/cache'
import { useLibrary } from './cloud/library'
import { createMemoryRepo, setLocalRepo, type LocalRepo } from './local'
import { useConnection, type ConnectionState } from './serverMode'
import { loadVocals, resetVocals, useVocalsStore } from './vocals'

const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
const BUCKET = 'build-chords-listener.firebasestorage.app'
const UID = 'uid42'
const ID = '0123456789ab'
const fetchMock = vi.fn<typeof fetch>()

function connect(patch: Partial<ConnectionState>) {
  useConnection.setState({ probing: false, failure: null, checkedAt: 1, health: null, permission: 'unsupported', ...patch })
}

const cloud = () => connect({ status: 'server', backend: 'cloud', apiBase: `${CLOUD}/api`, serverOrigin: CLOUD, remote: true })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const urls = () => fetchMock.mock.calls.map(([url]) => String(url))

const tokenUrl = (path: string, token: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`

function summary(id: string, version: number, createdAt = '2026-10-04T10:00:00Z'): TrackSummary {
  return { id, title: `Song ${id}`, duration: 10, source: { type: 'file', filename: `${id}.mp3` }, createdAt, version }
}

/** The live library answers for the signed-in user: these tracks, at these versions. */
function index(tracks: TrackSummary[]) {
  const versions: Record<string, number> = {}
  for (const t of tracks) if (t.version !== undefined) versions[t.id] = t.version
  useLibrary.setState({ uid: UID, tracks, versions, error: false })
}

/** The live library is started for the signed-in user, its first answer still on its way. */
const indexStarting = () => useLibrary.setState({ uid: UID, tracks: null, versions: {}, error: false })

/** track.json as the API publishes it. */
function trackFile(version: number, patch: Partial<TrackFile> = {}): TrackFile {
  return {
    id: ID,
    title: `Song v${version}`,
    duration: 10,
    source: { type: 'file', filename: 'song.mp3' },
    createdAt: '2026-10-04T10:00:00Z',
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
    stems: [],
    version,
    media: { audio: { path: `users/${UID}/tracks/${ID}/audio.mp3`, token: `tok${version}` }, stems: {} },
    ...patch,
  }
}

/** A track as GET /tracks/{id} sends it (signed URLs, no version). */
function apiTrack(patch: Partial<Track> = {}): Track {
  return {
    id: ID,
    title: 'From the API',
    duration: 10,
    source: { type: 'file', filename: 'song.mp3' },
    createdAt: '2026-10-04T10:00:00Z',
    audioUrl: `/api/tracks/${ID}/audio?u=${UID}&exp=1790000000&sig=abc`,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
    ...patch,
  }
}

const notes: TrackNotes = { version: 1, engine: 'basic-pitch', notes: [[0, 1, 60, 0.8]] }

let repo: LocalRepo

/** A track analyzed in this browser (listed in every mode). */
async function browserTrack(id: string, createdAt: string) {
  await repo.putWithAudio(
    {
      id,
      title: id,
      artist: null,
      createdAt,
      updatedAt: createdAt,
      source: { type: 'file', filename: `${id}.mp3` },
      mime: 'audio/mpeg',
      size: 1,
      analysis: { duration: 5, tempo: 120, timeSignature: 4, beats: [], downbeats: [], chords: [], key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0.8 }, waveform: [], engine: 'test 1' },
      edits: null,
    },
    new Blob(['x']),
  )
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
  repo = createMemoryRepo()
  setLocalRepo(repo)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('location', new URL('https://shchadylotaras.github.io/chords-listener/'))
  auth.user = { uid: UID, email: 'listener@example.com' }
  files.readTrackFile.mockReset().mockResolvedValue(null)
  files.readJsonFile.mockReset().mockResolvedValue(null)
  trouble.noteServerTrouble.mockReset()
  resetVocals()
  cloud()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setLocalRepo(null)
  useLibrary.setState({ uid: null, tracks: null, versions: {}, error: false })
  api.libraryWait.ms = api.LIBRARY_WAIT_MS
  connect({ status: 'checking', backend: null, apiBase: null, serverOrigin: null, remote: false })
})

describe('the library list', () => {
  it('comes from the index, with the browser’s own tracks, and asks the cloud nothing', async () => {
    await browserTrack('local-1', '2026-10-05T09:00:00Z')
    index([summary('b', 2, '2026-10-05T11:00:00Z'), summary('a', 7, '2026-10-04T10:00:00Z')])
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['b', 'local-1', 'a'])
    expect((await api.listTracks(undefined, { force: true })).map((t) => t.id)).toEqual(['b', 'local-1', 'a'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is kept on this device for the next first paint', async () => {
    index([summary('b', 2), summary('a', 7)])
    await api.listTracks()
    // the next visit, before the index answers
    indexStarting()
    expect((await api.listCachedTracks())?.map((t) => t.id).sort()).toEqual(['a', 'b'])
    expect((await cachedList(UID))?.tracks.map((t) => t.version)).toEqual([2, 7])
  })

  it('what is first painted while the index answers is the index itself', async () => {
    await saveList(UID, [summary('old', 1)])
    index([summary('a', 7)])
    expect((await api.listCachedTracks())?.map((t) => t.id)).toEqual(['a'])
  })

  it('a deleted track disappears with its document', async () => {
    index([summary('a', 1), summary('b', 1)])
    expect((await api.listTracks()).map((t) => t.id).sort()).toEqual(['a', 'b'])
    index([summary('b', 1)])
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['b'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('before the index answers: the list kept here, nothing asked', async () => {
    await saveList(UID, [summary('a', 3)])
    indexStarting()
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('before the index answers, nothing kept (or asked for now): its first answer is waited for', async () => {
    indexStarting()
    const listed = api.listTracks()
    await new Promise((r) => setTimeout(r, 10))
    index([summary('a', 1)])
    expect((await listed).map((t) => t.id)).toEqual(['a'])

    await saveList(UID, [summary('kept', 1)])
    indexStarting()
    const forced = api.listTracks(undefined, { force: true })
    await new Promise((r) => setTimeout(r, 10))
    index([summary('new', 1)])
    expect((await forced).map((t) => t.id)).toEqual(['new'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the index does not answer in time: the API path', async () => {
    api.libraryWait.ms = 20
    indexStarting()
    fetchMock.mockResolvedValueOnce(json([summary('a', 1)]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
    expect(urls()).toEqual([`${CLOUD}/api/tracks`])
  })

  it('the index failed (no rules yet, offline, SDK blocked): the API path as before, kept for LIST_TTL_MS', async () => {
    useLibrary.setState({ uid: UID, tracks: [summary('stale', 1)], versions: { stale: 1 }, error: true })
    fetchMock.mockResolvedValueOnce(json([apiTrack({ id: 'a' })]))
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
    expect((await api.listTracks()).map((t) => t.id)).toEqual(['a'])
    expect(urls()).toEqual([`${CLOUD}/api/tracks`])
  })

  it('an index failure before its first answer: the API path', async () => {
    indexStarting()
    const listed = api.listTracks()
    fetchMock.mockResolvedValueOnce(json([summary('a', 1)]))
    useLibrary.setState({ error: true })
    expect((await listed).map((t) => t.id)).toEqual(['a'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a track', () => {
  it('kept at the index’s version: from this device, nothing read, nothing asked — at any age', async () => {
    index([summary(ID, 3)])
    files.readTrackFile.mockResolvedValueOnce(trackFile(3))
    expect((await api.getTrack(ID)).title).toBe('Song v3')
    vi.setSystemTime(Date.now() + 3 * TRACK_TTL_MS)
    const again = await api.getTrack(ID)
    expect(again).toMatchObject({ title: 'Song v3', version: 3 })
    expect(files.readTrackFile).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the index moved on: read again from Storage, kept with its version, its media as token URLs', async () => {
    index([summary(ID, 3)])
    files.readTrackFile.mockResolvedValueOnce(trackFile(3))
    await api.getTrack(ID)
    index([summary(ID, 4)])
    files.readTrackFile.mockResolvedValueOnce(
      trackFile(4, { stems: ['vocals'], media: { audio: { path: `users/${UID}/tracks/${ID}/audio.mp3`, token: 'tok4' }, stems: { vocals: { path: `users/${UID}/tracks/${ID}/stems/vocals.mp3`, token: 'v4' } } } }),
    )
    const track = await api.getTrack(ID)
    expect(files.readTrackFile).toHaveBeenLastCalledWith(UID, ID)
    expect(track).toMatchObject({ title: 'Song v4', version: 4 })
    expect(track.audioUrl).toBe(tokenUrl(`users/${UID}/tracks/${ID}/audio.mp3`, 'tok4'))
    expect(track.stemUrls).toEqual({ vocals: tokenUrl(`users/${UID}/tracks/${ID}/stems/vocals.mp3`, 'v4') })
    expect(await cachedTrackAt(UID, ID, 4)).toMatchObject({ title: 'Song v4' })
    expect(await cachedTrackAt(UID, ID, 3)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a copy the API sent (no version) is not trusted while the index answers: read from Storage', async () => {
    await saveTrack(UID, apiTrack())
    index([summary(ID, 2)])
    files.readTrackFile.mockResolvedValueOnce(trackFile(2))
    expect((await api.getTrack(ID)).title).toBe('Song v2')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no track.json (not published yet) or an unreadable one: the API path, kept as before', async () => {
    index([summary(ID, 2)])
    files.readTrackFile.mockResolvedValueOnce(null)
    fetchMock.mockResolvedValueOnce(json(apiTrack()))
    const track = await api.getTrack(ID)
    expect(track.title).toBe('From the API')
    expect(track.audioUrl).toBe(`${CLOUD}/api/tracks/${ID}/audio?u=${UID}&exp=1790000000&sig=abc`)
    expect(urls()).toEqual([`${CLOUD}/api/tracks/${ID}`])
    expect(await cachedTrack(UID, ID)).toMatchObject({ title: 'From the API' })

    files.readTrackFile.mockRejectedValueOnce(new api.ApiError('denied', 'unauthorized'))
    fetchMock.mockResolvedValueOnce(json(apiTrack({ title: 'Again' })))
    expect((await api.getTrack(ID)).title).toBe('Again')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('not in the index (deleted on another device, or brand new): the API is asked, and a 404 forgets it here', async () => {
    index([summary(ID, 1)])
    files.readTrackFile.mockResolvedValueOnce(trackFile(1))
    await api.getTrack(ID)
    index([])
    fetchMock.mockResolvedValueOnce(json({ detail: 'Track not found', code: 'not_found' }, 404))
    await expect(api.getTrack(ID)).rejects.toMatchObject({ code: 'not_found' })
    expect(urls()).toEqual([`${CLOUD}/api/tracks/${ID}`])
    expect(files.readTrackFile).toHaveBeenCalledTimes(1)
    expect(await cachedTrackAt(UID, ID, 1)).toBeNull()
  })

  it('opened while the index is on its way: its first answer is waited for', async () => {
    index([summary(ID, 3)])
    files.readTrackFile.mockResolvedValueOnce(trackFile(3))
    await api.getTrack(ID)
    indexStarting()
    const opened = api.getTrack(ID)
    await new Promise((r) => setTimeout(r, 10))
    index([summary(ID, 3)])
    expect((await opened).title).toBe('Song v3')
    expect(files.readTrackFile).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('left while waiting for the index: aborted', async () => {
    indexStarting()
    const ctrl = new AbortController()
    const opened = api.getTrack(ID, ctrl.signal)
    ctrl.abort()
    index([summary(ID, 3)])
    await expect(opened).rejects.toMatchObject({ code: 'aborted' })
  })

  it('the index failed: the phase-1 path (the copy kept here for TRACK_TTL_MS, then the API)', async () => {
    await saveTrack(UID, apiTrack())
    useLibrary.setState({ uid: UID, tracks: [summary(ID, 9)], versions: { [ID]: 9 }, error: true })
    expect((await api.getTrack(ID)).title).toBe('From the API')
    expect(files.readTrackFile).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() + TRACK_TTL_MS)
    fetchMock.mockResolvedValueOnce(json(apiTrack({ title: 'Fresh' })))
    expect((await api.getTrack(ID)).title).toBe('Fresh')
  })

  it('its token URL is downloaded and kept like a signed one; failing, it says nothing about the API server', async () => {
    index([summary(ID, 3)])
    files.readTrackFile.mockResolvedValueOnce(trackFile(3))
    const track = await api.getTrack(ID)
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['mp3'])))
    expect(await (await api.fetchTrackAudio(track)).text()).toBe('mp3')
    expect(urls()).toEqual([tokenUrl(`users/${UID}/tracks/${ID}/audio.mp3`, 'tok3')])
    expect(await cachedAudio(UID, ID)).not.toBeNull()

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.fetchMedia(track.audioUrl)).rejects.toMatchObject({ code: 'network' })
    expect(trouble.noteServerTrouble).not.toHaveBeenCalled()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.fetchMedia(`${CLOUD}/api/tracks/${ID}/stems/vocals?sig=1`)).rejects.toMatchObject({ code: 'network' })
    expect(trouble.noteServerTrouble).toHaveBeenCalledTimes(1)
  })
})

describe('live-piano notes and vocal notes', () => {
  it('notes come from Storage, kept at the track’s version', async () => {
    index([summary(ID, 3)])
    files.readJsonFile.mockResolvedValueOnce(notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(files.readJsonFile).toHaveBeenCalledTimes(1)
    expect(files.readJsonFile).toHaveBeenCalledWith(UID, ID, 'notes.json')
    // the track changed: read again
    index([summary(ID, 4)])
    files.readJsonFile.mockResolvedValueOnce(notes)
    await api.getTrackNotes(ID)
    expect(files.readJsonFile).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('not computed yet (no notes.json): null, nothing kept — notes saved later elsewhere show on the next open', async () => {
    index([summary(ID, 3)])
    expect(await api.getTrackNotes(ID)).toBeNull()
    // another device computes them (PUT /notes leaves the version as it is)
    files.readJsonFile.mockResolvedValueOnce(notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(files.readJsonFile).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Storage failing: the API answers, kept at the version (asked once)', async () => {
    index([summary(ID, 3)])
    files.readJsonFile.mockRejectedValue(new api.ApiError('CORS', 'network'))
    fetchMock.mockResolvedValueOnce(json(notes))
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(urls()).toEqual([`${CLOUD}/api/tracks/${ID}/notes`])

    // none on the API either
    index([summary(ID, 4)])
    fetchMock.mockResolvedValueOnce(json({ detail: 'No notes', code: 'not_found' }, 404))
    expect(await api.getTrackNotes(ID)).toBeNull()
  })

  it('notes saved here are kept at the index’s version', async () => {
    index([summary(ID, 3)])
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.saveTrackNotes(ID, notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(files.readJsonFile).not.toHaveBeenCalled()
    expect(urls()).toEqual([`${CLOUD}/api/tracks/${ID}/notes`])
  })

  it('the index failed: notes the phase-1 way (kept here, else the API)', async () => {
    useLibrary.setState({ uid: UID, tracks: null, versions: {}, error: true })
    fetchMock.mockResolvedValueOnce(json(notes))
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(await api.getTrackNotes(ID)).toEqual(notes)
    expect(files.readJsonFile).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('vocal notes come from Storage; none there: not transcribed yet, nothing asked', async () => {
    const vocals: VocalNotes = { version: 1, engine: 'crepe', tuningCents: 0, notes: [[0, 1, 60, 0.8]] }
    index([summary(ID, 5)])
    files.readJsonFile.mockResolvedValueOnce(vocals)
    await loadVocals({ id: ID, duration: 10, vocals: true })
    expect(files.readJsonFile).toHaveBeenCalledWith(UID, ID, 'vocals.json')
    expect(useVocalsStore.getState().tracks[ID]).toMatchObject({ status: 'ready', notes: vocals })
    // kept at the version: the next open reads nothing
    resetVocals()
    await loadVocals({ id: ID, duration: 10, vocals: true })
    expect(useVocalsStore.getState().tracks[ID]).toMatchObject({ status: 'ready' })
    expect(files.readJsonFile).toHaveBeenCalledTimes(1)

    resetVocals()
    index([summary(ID, 6)])
    files.readJsonFile.mockResolvedValueOnce(null)
    await loadVocals({ id: ID, duration: 10, vocals: true })
    expect(useVocalsStore.getState().tracks[ID]).toEqual({ status: 'missing' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('vocal notes Storage cannot give: the API', async () => {
    const vocals: VocalNotes = { version: 1, engine: 'crepe', tuningCents: 0, notes: [[0, 1, 60, 0.8]] }
    index([summary(ID, 5)])
    files.readJsonFile.mockRejectedValueOnce(new api.ApiError('denied', 'unauthorized'))
    fetchMock.mockResolvedValueOnce(json(vocals))
    await loadVocals({ id: ID, duration: 10, vocals: true })
    expect(useVocalsStore.getState().tracks[ID]).toMatchObject({ status: 'ready', notes: vocals })
    expect(urls()).toEqual([`${CLOUD}/api/tracks/${ID}/vocals`])
  })
})

describe('never for a local server or a guest', () => {
  it('a local server: the API, whatever the index store holds', async () => {
    connect({ status: 'server', backend: 'local', apiBase: 'http://localhost:8765/api', serverOrigin: 'http://localhost:8765', remote: true })
    index([summary(ID, 3)])
    fetchMock.mockResolvedValueOnce(json([apiTrack()])).mockResolvedValueOnce(json(apiTrack())).mockResolvedValueOnce(json(notes))
    await api.listTracks()
    await api.getTrack(ID)
    await api.getTrackNotes(ID)
    expect(urls()).toEqual(['http://localhost:8765/api/tracks', `http://localhost:8765/api/tracks/${ID}`, `http://localhost:8765/api/tracks/${ID}/notes`])
    expect(files.readTrackFile).not.toHaveBeenCalled()
    expect(files.readJsonFile).not.toHaveBeenCalled()
  })

  it('nobody signed in: no index, no Storage', async () => {
    auth.user = null
    index([summary(ID, 3)])
    fetchMock.mockResolvedValueOnce(json(apiTrack()))
    await api.getTrack(ID)
    expect(files.readTrackFile).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
