import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAnalysis } from './engine'
import type { Job, Track, TrackSummary } from '../types'

vi.mock('./engine', () => ({
  analyzeInBrowser: async (): Promise<BrowserAnalysis> => ({
    duration: 4,
    tempo: 100,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [{ start: 0, end: 4, label: 'D', root: 'D', quality: 'maj', bass: null, confidence: 1 }],
    key: { tonic: 'D', mode: 'major', name: 'D', confidence: 1 },
    waveform: [],
    engine: 'test',
  }),
}))

import * as api from './api'
import { createMemoryRepo, getLocalJob, setLocalRepo } from './local'
import { useConnection, type ConnectionState } from './serverMode'

const SERVER = 'http://localhost:8765'
const fetchMock = vi.fn<typeof fetch>()

function connect(patch: Partial<ConnectionState>) {
  useConnection.setState({ probing: false, failure: null, checkedAt: 1, health: null, ...patch })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function serverTrack(id: string, createdAt: string): Track {
  return {
    id,
    title: `Server ${id}`,
    duration: 10,
    source: { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ' },
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    createdAt,
    audioUrl: `/api/tracks/${id}/audio`,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
  }
}

async function finish(id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = getLocalJob(id)
    if (job?.status === 'done' || job?.status === 'error') return job
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error('job did not finish')
}

beforeEach(() => {
  setLocalRepo(createMemoryRepo())
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLocalRepo(null)
  connect({ status: 'checking', apiBase: null, serverOrigin: null, remote: false })
})

describe('browser mode (no server)', () => {
  beforeEach(() => connect({ status: 'browser', apiBase: null, serverOrigin: null, remote: false }))

  it('explains that links need the server', async () => {
    await expect(api.createJob('https://youtu.be/dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'server_required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('analyzes files locally and serves the result through the same API', async () => {
    const job = await api.uploadFile(new File(['abc'], 'Local_Tune.mp3', { type: 'audio/mpeg' }))
    expect(job.id.startsWith('local-job-')).toBe(true)
    expect((await api.getJob(job.id)).id).toBe(job.id)
    const done = await finish(job.id)
    const trackId = done.trackId as string

    expect((await api.listTracks()).map((t) => t.id)).toEqual([trackId])
    const track = await api.getTrack(trackId)
    expect(track).toMatchObject({ title: 'Local Tune', source: { type: 'file' } })

    const edited = await api.updateTrack(trackId, { chords: [{ ...track.chords[0], label: 'Dm', quality: 'min' }] })
    expect(edited.edited).toBe(true)
    expect((await api.resetTrack(trackId)).edited).toBe(false)
    expect((await api.reanalyzeTrack(trackId)).id.startsWith('local-job-')).toBe(true)
    await api.deleteTrack(trackId)
    await expect(api.getTrack(trackId)).rejects.toMatchObject({ code: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports server-only calls as network errors without hitting the network', async () => {
    await expect(api.getTrack('0123456789ab')).rejects.toMatchObject({ code: 'network' })
    await expect(api.getJob('feedfacecafe')).rejects.toMatchObject({ code: 'network' })
    expect(await api.listJobs()).toEqual(expect.any(Array))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('remote server mode (page on GitHub Pages, server on localhost)', () => {
  beforeEach(() => connect({ status: 'server', apiBase: `${SERVER}/api`, serverOrigin: SERVER, remote: true }))

  it('calls the configured server and resolves the URLs it returns', async () => {
    fetchMock.mockResolvedValueOnce(json(serverTrack('abc123def456', '2026-10-01T10:00:00Z')))
    const track = await api.getTrack('abc123def456')
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/tracks/abc123def456`)
    expect(track.audioUrl).toBe(`${SERVER}/api/tracks/abc123def456/audio`)
    expect(track.thumbnail).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(api.trackAudioUrl('abc123def456')).toBe(`${SERVER}/api/tracks/abc123def456/audio`)
  })

  it('lists the server library together with tracks analyzed in this browser', async () => {
    connect({ status: 'browser', apiBase: null, serverOrigin: null, remote: false })
    const local = await finish((await api.uploadFile(new File(['zzz'], 'mine.wav'))).id)
    connect({ status: 'server', apiBase: `${SERVER}/api`, serverOrigin: SERVER, remote: true })

    const older: TrackSummary = serverTrack('aaaaaaaaaaaa', '2000-01-01T00:00:00Z')
    fetchMock.mockResolvedValueOnce(json([older]))
    const list = await api.listTracks()
    expect(list.map((t) => t.id)).toEqual([local.trackId, 'aaaaaaaaaaaa'])

    // the server stops answering: the browser library is still listed
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await api.listTracks()).map((t) => t.id)).toEqual([local.trackId])
  })

  it('sends links and JSON edits to the server, keeping its error codes', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: 'j1', status: 'queued', progress: 0, message: '', createdAt: '2026-10-04T00:00:00Z' }, 201),
    )
    const job = await api.createJob('https://youtu.be/dQw4w9WgXcQ')
    expect(job.id).toBe('j1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${SERVER}/api/jobs`)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')

    fetchMock.mockResolvedValueOnce(json({ detail: 'Track not found', code: 'not_found' }, 404))
    await expect(api.updateTrack('abc123def456', { title: 'x' })).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})
