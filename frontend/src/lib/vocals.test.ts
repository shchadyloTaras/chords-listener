import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, VocalNotes } from '../types'

const api = vi.hoisted(() => ({
  apiRequest: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  getJob: vi.fn<(id: string) => Promise<Job>>(),
  listJobs: vi.fn<() => Promise<Job[]>>(),
  fetchTrackAudio: vi.fn<(track: { id: string; audioUrl: string }) => Promise<Blob>>(),
}))

vi.mock('./api', async () => {
  const real = await vi.importActual<typeof import('./api')>('./api')
  return { ...real, ...api }
})

import { ApiError } from './api'
import { useConnection } from './serverMode'
import { fetchStem, loadVocals, resetVocals, startVocals, stemsOf, useVocalsStore, vocalsPolling, vocalsSupport, type VocalsState } from './vocals'

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
  vocalsPolling.ms = 5
  resetVocals()
  useConnection.setState({ status: 'server', apiBase: '/api', health: { ok: true, engine: { name: 'x', version: '1', features: { vocals: true } }, ytdlp: null, ffmpeg: true } })
  for (const f of Object.values(api)) f.mockReset()
  api.listJobs.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
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

  it('resumes following a job that is already running', async () => {
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
    api.fetchTrackAudio.mockResolvedValue(new Blob(['signed']))
    await fetchStem({ ...track, stemUrls: { instruments: '/api/tracks/x/stems/instruments?sig=1' } }, 'instruments')
    expect(api.fetchTrackAudio).toHaveBeenCalledWith({ id: track.id, audioUrl: '/api/tracks/x/stems/instruments?sig=1' }, undefined)
    api.apiFetch.mockResolvedValue(new Response(JSON.stringify({ detail: 'gone', code: 'not_found' }), { status: 404 }))
    await expect(fetchStem(track, 'vocals')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})
