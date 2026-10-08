import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, VocalNotes } from '../types'

const api = vi.hoisted(() => ({
  apiRequest: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  getJob: vi.fn<(id: string) => Promise<Job>>(),
  cancelJob: vi.fn<(id: string) => Promise<Job>>(),
  listJobs: vi.fn<() => Promise<Job[]>>(),
  fetchTrackAudio: vi.fn<(track: { id: string; audioUrl: string }) => Promise<Blob>>(),
  fetchMedia: vi.fn<(url: string, signal?: AbortSignal) => Promise<Blob>>(),
}))

vi.mock('./api', async () => {
  const real = await vi.importActual<typeof import('./api')>('./api')
  return { ...real, ...api }
})

import { useJobs } from '../hooks/useJobs'
import { ApiError } from './api'
import { useAuth } from './auth'
import { recentServerJobs, rememberServerJob } from './cloud/activity'
import { refreshCloudHealth, useConnection } from './serverMode'
import {
  cancelVocals,
  fetchStem,
  loadVocals,
  resetVocals,
  startVocals,
  stemsOf,
  useVocalsStore,
  VOCALS_POLL_MS,
  vocalsPolling,
  vocalsSupport,
  type VocalsState,
} from './vocals'

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

const NOTES: VocalNotes = {
  version: 1,
  engine: 'htdemucs + torchcrepe-tiny',
  tuningCents: -12,
  notes: [
    [0.5, 1, 64, 0.8],
    [1, 1.5, 67, 0.7],
  ],
  range: { low: 64, high: 67 },
}
const track = { id: 'abcdef123456', duration: 30 }
const job = (over: Partial<Job> = {}): Job => ({
  id: 'job1',
  kind: 'vocals',
  status: 'analyzing',
  progress: 0.2,
  message: 'Separating vocals',
  trackId: track.id,
  createdAt: '2026-10-05T00:00:00Z',
  ...over,
})

const state = (): VocalsState => useVocalsStore.getState().tracks[track.id] ?? { status: 'idle' }

async function until(pred: (s: VocalsState) => boolean, ms = 3000): Promise<VocalsState> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred(state())) return state()
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`state stuck at ${JSON.stringify(state())}`)
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vocalsPolling.ms = 5
  resetVocals()
  useJobs.setState({ jobs: {} })
  useConnection.setState({ status: 'server', backend: null, failure: null, apiBase: '/api', health: { ok: true, engine: { name: 'x', version: '1', features: { vocals: true } }, ytdlp: null, ffmpeg: true } })
  for (const f of Object.values(api)) f.mockReset()
  api.listJobs.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('vocals client', () => {
  it('knows where vocals cannot be transcribed', () => {
    expect(vocalsSupport({ id: 'local-123' })).toBe('browser')
    expect(vocalsSupport(track)).toBe('ok')
    useConnection.setState({ health: { ok: true, engine: { name: 'x', version: '1', features: { vocals: false } }, ytdlp: null, ffmpeg: true } })
    expect(vocalsSupport(track)).toBe('server')
    useConnection.setState({ status: 'browser' })
    expect(vocalsSupport(track)).toBe('browser')
  })

  it('loads saved vocal notes', async () => {
    api.apiRequest.mockResolvedValue(NOTES)
    await loadVocals(track)
    const s = state()
    expect(s.status).toBe('ready')
    if (s.status === 'ready') {
      expect(s.index.count).toBe(2)
      expect(s.notes.tuningCents).toBe(-12)
    }
    expect(api.apiRequest).toHaveBeenCalledWith(`/tracks/${track.id}/vocals`, expect.anything())
    // the stems are known from now on
    expect(stemsOf(track)).toEqual(expect.arrayContaining(['vocals', 'instruments']))
  })

  it('reports "missing" when nothing was transcribed yet', async () => {
    api.apiRequest.mockRejectedValue(new ApiError('nope', 'not_found', 404))
    await loadVocals(track)
    expect(state()).toEqual({ status: 'missing' })
  })

  it('a browser track has no server to transcribe it', async () => {
    await loadVocals({ id: 'local-1', duration: 10 })
    expect(useVocalsStore.getState().tracks['local-1']).toEqual({ status: 'unavailable', reason: 'browser' })
    expect(api.apiRequest).not.toHaveBeenCalled()
  })

  it('starts a job, follows its stages and loads the result', async () => {
    let polls = 0
    api.apiRequest.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') return job({ status: 'queued', progress: 0, message: 'Queued' })
      return NOTES
    })
    api.getJob.mockImplementation(async () => {
      polls++
      if (polls === 1) return job({ progress: 0.3, message: 'Separating vocals' })
      if (polls === 2) return job({ progress: 0.8, message: 'Tracking the melody' })
      return job({ status: 'done', progress: 1, message: 'Done' })
    })
    await startVocals(track)
    expect(state()).toMatchObject({ status: 'running', stage: 'queued' })
    await until((s) => s.status === 'running' && s.stage === 'separate')
    await until((s) => s.status === 'running' && s.stage === 'melody')
    const done = await until((s) => s.status === 'ready')
    expect(done.status).toBe('ready')
    expect(api.apiRequest.mock.calls[0]).toEqual([`/tracks/${track.id}/vocals`, { method: 'POST', body: '{}' }])
  })

  it('a server without the feature answers 501: unavailable', async () => {
    api.apiRequest.mockRejectedValue(new ApiError('Not installed', 'internal', 501))
    await startVocals(track)
    expect(state()).toEqual({ status: 'unavailable', reason: 'server' })
  })

  it('a failed job shows its error code', async () => {
    api.apiRequest.mockResolvedValue(job())
    api.getJob.mockResolvedValue(job({ status: 'error', errorCode: 'quota_exceeded', error: 'Daily limit' }))
    await startVocals(track)
    const s = await until((x) => x.status === 'error')
    expect(s).toMatchObject({ status: 'error', code: 'quota_exceeded', during: 'job' })
  })

  it('cancels the running job: the vocals are missing again and the polling stops', async () => {
    api.apiRequest.mockResolvedValue(job())
    api.getJob.mockResolvedValue(job())
    api.cancelJob.mockResolvedValue(job())
    await startVocals(track)
    expect(state()).toMatchObject({ status: 'running', jobId: 'job1' })
    await cancelVocals(track)
    expect(api.cancelJob).toHaveBeenCalledWith('job1')
    expect(state()).toEqual({ status: 'missing' })
    const polls = api.getJob.mock.calls.length
    await new Promise((r) => setTimeout(r, 40))
    expect(api.getJob.mock.calls.length).toBeLessThanOrEqual(polls + 1)
    expect(state()).toEqual({ status: 'missing' })
  })

  it('a job cancelled elsewhere (another tab) leaves the vocals missing, not failed', async () => {
    api.apiRequest.mockResolvedValue(job())
    api.getJob.mockResolvedValue(job({ status: 'error', errorCode: 'cancelled', error: 'Cancelled' }))
    await startVocals(track)
    await until((s) => s.status === 'missing')
  })

  it('a cancel the server refuses keeps the job running', async () => {
    api.apiRequest.mockResolvedValue(job())
    api.getJob.mockResolvedValue(job())
    api.cancelJob.mockRejectedValue(new ApiError('offline', 'network', 0))
    await startVocals(track)
    await expect(cancelVocals(track)).rejects.toThrow('offline')
    expect(state()).toMatchObject({ status: 'running', jobId: 'job1' })
  })

  it('a server older than cancelling (404 while the job runs) keeps the job running', async () => {
    api.apiRequest.mockResolvedValue(job())
    api.getJob.mockResolvedValue(job())
    api.cancelJob.mockRejectedValue(new ApiError('Not Found', 'not_found', 404))
    await startVocals(track)
    await expect(cancelVocals(track)).rejects.toThrow('Not Found')
    expect(state()).toMatchObject({ status: 'running', jobId: 'job1' })
  })

  it('a job already gone from the server: the vocals are missing again', async () => {
    api.apiRequest.mockResolvedValue(job())
    api.getJob.mockRejectedValue(new ApiError('Job not found', 'not_found', 404))
    api.cancelJob.mockRejectedValue(new ApiError('Job not found', 'not_found', 404))
    vocalsPolling.ms = 10_000
    await startVocals(track)
    await cancelVocals(track)
    expect(state()).toEqual({ status: 'missing' })
  })

  it('resumes following a job that is already running', async () => {
    // started on this device (another tab, or before a reload)
    rememberServerJob('job7')
    api.apiRequest.mockRejectedValueOnce(new ApiError('nope', 'not_found', 404)).mockResolvedValue(NOTES)
    api.listJobs.mockResolvedValue([job({ id: 'job7', progress: 0.5 })])
    api.getJob.mockResolvedValue(job({ id: 'job7', status: 'done', progress: 1 }))
    await loadVocals(track)
    expect(state()).toMatchObject({ status: 'running', jobId: 'job7' })
    await until((s) => s.status === 'ready')
  })

  it('downloads a stem through the API (or a signed URL from the track)', async () => {
    api.apiFetch.mockResolvedValue(new Response(new Blob(['mp3']), { status: 200 }))
    const blob = await fetchStem(track, 'instruments')
    expect(await blob.text()).toBe('mp3')
    expect(api.apiFetch.mock.calls[0][0]).toBe(`/tracks/${track.id}/stems/instruments`)
    api.fetchMedia.mockResolvedValue(new Blob(['signed']))
    await fetchStem({ ...track, stemUrls: { instruments: '/api/tracks/x/stems/instruments?sig=1' } }, 'instruments')
    expect(api.fetchMedia).toHaveBeenCalledWith('/api/tracks/x/stems/instruments?sig=1', undefined, { trackId: track.id, stem: 'instruments' })
    // a stem is not the track's audio (the copy of that kept on this device must not stand in for it)
    expect(api.fetchTrackAudio).not.toHaveBeenCalled()
    api.apiFetch.mockResolvedValue(new Response(JSON.stringify({ detail: 'gone', code: 'not_found' }), { status: 404 }))
    await expect(fetchStem(track, 'vocals')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('cloud: vocal notes found once come from this device next time', async () => {
    globalThis.indexedDB = new IDBFactory()
    useConnection.setState({ backend: 'cloud' })
    useAuth.setState({ user: { uid: 'uid42', email: null } })
    try {
      api.apiRequest.mockResolvedValue(NOTES)
      await loadVocals(track)
      resetVocals()
      await loadVocals(track)
      expect(state().status).toBe('ready')
      expect(api.apiRequest).toHaveBeenCalledTimes(1)
    } finally {
      useAuth.setState({ user: null })
    }
  })

  it('no vocal notes and no job started on this device lately: the job list is not asked', async () => {
    api.apiRequest.mockRejectedValue(new ApiError('nope', 'not_found', 404))
    await loadVocals(track)
    expect(state()).toEqual({ status: 'missing' })
    expect(api.listJobs).not.toHaveBeenCalled()
  })

  it('on the cloud, a song whose track says it has no vocals asks nothing, not even the health', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    useConnection.setState({ backend: 'cloud', apiBase: 'https://cloud.example/api', health: null, failure: null })
    await loadVocals({ ...track, vocals: false })
    await new Promise((r) => setTimeout(r, 5))
    expect(state()).toEqual({ status: 'missing' })
    expect(api.apiRequest).not.toHaveBeenCalled()
    expect(api.listJobs).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a song without vocals yet, while a vocals job started here may still run: picks it up', async () => {
    rememberServerJob('job7')
    api.listJobs.mockResolvedValue([job({ id: 'job7', progress: 0.5 })])
    api.getJob.mockResolvedValue(job({ id: 'job7', status: 'done', progress: 1 }))
    api.apiRequest.mockResolvedValue(NOTES)
    await loadVocals({ ...track, vocals: false })
    expect(state()).toMatchObject({ status: 'running', jobId: 'job7' })
    await until((s) => s.status === 'ready')
  })

  it('polls a running job calmly', () => {
    expect(VOCALS_POLL_MS).toBe(1500)
  })

  it('remembers the job it starts (a reload looks for it)', async () => {
    api.apiRequest.mockResolvedValue(job({ id: 'job5' }))
    api.getJob.mockResolvedValue(job({ id: 'job5', status: 'error', errorCode: 'internal' }))
    await startVocals(track)
    expect(recentServerJobs()).toContain('job5')
    await until((s) => s.status === 'error')
  })

  it('follows a job the job list already polls, without polling it again', async () => {
    useJobs.setState({ jobs: { job1: job() } })
    api.apiRequest.mockImplementation(async (_path, init) => (init?.method === 'POST' ? job() : NOTES))
    await startVocals(track)
    await new Promise((r) => setTimeout(r, 30))
    expect(state()).toMatchObject({ status: 'running', jobId: 'job1', stage: 'separate' })
    useJobs.setState({ jobs: { job1: job({ progress: 0.8, message: 'Tracking the melody' }) } })
    await until((s) => s.status === 'running' && s.stage === 'melody')
    useJobs.setState({ jobs: { job1: job({ status: 'done', progress: 1, message: 'Done' }) } })
    await until((s) => s.status === 'ready')
    expect(api.getJob).not.toHaveBeenCalled()
  })

  it('does not poll while the tab is hidden', async () => {
    const doc = { hidden: true }
    vi.stubGlobal('document', doc)
    api.apiRequest.mockImplementation(async (_path, init) => (init?.method === 'POST' ? job() : NOTES))
    api.getJob.mockResolvedValue(job({ status: 'done', progress: 1, message: 'Done' }))
    await startVocals(track)
    await new Promise((r) => setTimeout(r, 40))
    expect(api.getJob).not.toHaveBeenCalled()
    doc.hidden = false
    await until((s) => s.status === 'ready')
    expect(api.getJob).toHaveBeenCalledTimes(1)
  })

  it('on the cloud, goes by the features seen last time instead of asking again', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const noVocals = { ok: true, engine: { name: 'x', version: '1', features: { vocals: false } }, ytdlp: null, ffmpeg: true }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(noVocals), { status: 200 }))
    useConnection.setState({ backend: 'cloud', apiBase: 'https://cloud.example/api', health: null, failure: null })
    await refreshCloudHealth()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // another page load: the health has not been asked for
    useConnection.setState({ health: null })
    expect(vocalsSupport(track)).toBe('server')
    await new Promise((r) => setTimeout(r, 5))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('on the cloud, asks for its health once when nothing is known (and tries meanwhile)', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const noVocals = { ok: true, engine: { name: 'x', version: '1', features: { vocals: false } }, ytdlp: null, ffmpeg: true }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(noVocals), { status: 200 }))
    useConnection.setState({ backend: 'cloud', apiBase: 'https://cloud.example/api', health: null, failure: null })
    expect(vocalsSupport(track)).toBe('ok')
    expect(vocalsSupport(track)).toBe('ok')
    await vi.waitFor(() => expect(useConnection.getState().health).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vocalsSupport(track)).toBe('server')
  })
})
