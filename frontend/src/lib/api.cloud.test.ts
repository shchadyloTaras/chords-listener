// The cloud API mode (docs/CLOUD.md): ID token on every call, session renewal, quotas, signed media URLs,
// uploads through Firebase Storage. Firebase itself is mocked (lib/auth, lib/cloud/storage).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAnalysis } from './engine'
import type { Job, Track } from '../types'

const auth = vi.hoisted(() => ({
  getIdToken: vi.fn<(forceRefresh?: boolean) => Promise<string | null>>(),
  requestSignIn: vi.fn<(reason?: string) => Promise<boolean>>(),
  user: { uid: 'uid42', email: 'listener@example.com' } as { uid: string; email: string | null } | null,
}))

vi.mock('./auth', () => ({
  getIdToken: auth.getIdToken,
  requestSignIn: auth.requestSignIn,
  useAuth: { getState: () => ({ user: auth.user, ready: true }), subscribe: () => () => undefined },
}))

const storage = vi.hoisted(() => ({ uploadToStorage: vi.fn() }))
vi.mock('./cloud/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cloud/storage')>()),
  uploadToStorage: storage.uploadToStorage,
}))

vi.mock('./engine', () => ({
  analyzeInBrowser: async (): Promise<BrowserAnalysis> => ({
    duration: 4,
    tempo: 100,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [{ start: 0, end: 4, label: 'G', root: 'G', quality: 'maj', bass: null, confidence: 1 }],
    key: { tonic: 'G', mode: 'major', name: 'G', confidence: 1 },
    waveform: [],
    engine: 'test',
  }),
}))

import * as api from './api'
import { errorText, errorTitle } from '../components/jobs/errorText'
import { recentServerJobs } from './cloud/activity'
import { createMemoryRepo, getLocalJob, setLocalRepo } from './local'
import { useConnection, type ConnectionState } from './serverMode'
import { SUPPORT_EMAIL } from '../i18n/cloud'

const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
const fetchMock = vi.fn<typeof fetch>()

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

function connect(patch: Partial<ConnectionState>) {
  useConnection.setState({ probing: false, failure: null, checkedAt: 1, health: null, permission: 'unsupported', ...patch })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const unauthorized = () => json({ detail: 'Sign in first', code: 'unauthorized' }, 401)

function authHeader(call: number): string | null {
  return new Headers(fetchMock.mock.calls[call][1]?.headers).get('Authorization')
}

const signedAudio = '/api/tracks/0123456789ab/audio?u=uid42&exp=1790000000&sig=c0ffee'

function cloudTrack(): Track {
  return {
    id: '0123456789ab',
    title: 'Cloud song',
    duration: 10,
    source: { type: 'file', filename: 'song.mp3' },
    createdAt: '2026-10-04T10:00:00Z',
    audioUrl: signedAudio,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
  }
}

const job: Job = { id: 'job1', status: 'queued', progress: 0, message: 'Queued', createdAt: '2026-10-04T10:00:00Z' }

let hour = 0

beforeEach(() => {
  // each test an hour later: a paused sign-in prompt never leaks into the next one
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 5, 0, 0, 0) + ++hour * 3_600_000)
  setLocalRepo(createMemoryRepo())
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  auth.user = { uid: 'uid42', email: 'listener@example.com' }
  auth.getIdToken.mockReset().mockImplementation(async (force) => (force ? 'fresh-token' : 'token-1'))
  auth.requestSignIn.mockReset().mockResolvedValue(false)
  storage.uploadToStorage.mockReset()
  connect({ status: 'server', backend: 'cloud', apiBase: `${CLOUD}/api`, serverOrigin: CLOUD, remote: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setLocalRepo(null)
  connect({ status: 'checking', backend: null, apiBase: null, serverOrigin: null, remote: false })
})

describe('cloud requests', () => {
  it('send the Firebase ID token with every call except /health', async () => {
    fetchMock.mockResolvedValueOnce(json(cloudTrack()))
    await api.getTrack('0123456789ab')
    expect(fetchMock.mock.calls[0][0]).toBe(`${CLOUD}/api/tracks/0123456789ab`)
    expect(authHeader(0)).toBe('Bearer token-1')

    fetchMock.mockResolvedValueOnce(json({ ok: true, engine: { name: 'madmom', version: '1', features: {} }, ytdlp: '1', ffmpeg: true }))
    await api.getHealth()
    expect(fetchMock.mock.calls[1][0]).toBe(`${CLOUD}/api/health`)
    expect(authHeader(1)).toBeNull()
  })

  it('never send the token to the user’s own server', async () => {
    connect({ status: 'server', backend: 'local', apiBase: 'http://localhost:8765/api', serverOrigin: 'http://localhost:8765', remote: true })
    fetchMock.mockResolvedValueOnce(json([]))
    await api.listTracks()
    expect(authHeader(0)).toBeNull()
    expect(auth.getIdToken).not.toHaveBeenCalled()
  })

  it('resolve signed media URLs against the cloud', async () => {
    fetchMock.mockResolvedValueOnce(json(cloudTrack()))
    const track = await api.getTrack('0123456789ab')
    expect(track.audioUrl).toBe(`${CLOUD}${signedAudio}`)
  })

  it('resolves stem URLs against the cloud origin', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ...cloudTrack(), id: 'abc', stemUrls: { vocals: '/api/tracks/abc/stems/vocals?u=1&exp=2&sig=3' } }),
    )
    const track = await api.getTrack('abc')
    expect(track.stemUrls?.vocals).toBe(`${CLOUD}/api/tracks/abc/stems/vocals?u=1&exp=2&sig=3`)
  })

  it('remember the running jobs started here (a reload looks for them), not finished ones', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    fetchMock.mockResolvedValueOnce(json(job, 201))
    await api.createJob('https://soundcloud.com/a/b')
    expect(recentServerJobs()).toEqual(['job1'])

    // the same link analyzed before: the job comes back done
    fetchMock.mockResolvedValueOnce(json({ ...job, id: 'job2', status: 'done', trackId: 't1' }, 201))
    await api.createJob('https://soundcloud.com/a/c')
    expect(recentServerJobs()).toEqual(['job1'])

    storage.uploadToStorage.mockResolvedValue('users/uid42/uploads/abc/a.mp3')
    fetchMock.mockResolvedValueOnce(json({ ...job, id: 'job3' }, 201))
    await api.uploadFile(new File(['x'], 'a.mp3'))
    expect(recentServerJobs()).toEqual(['job1', 'job3'])

    // the last poll says it is over: nothing left to look for after a reload
    fetchMock.mockResolvedValueOnce(json({ ...job, status: 'done', trackId: 't1' }))
    await api.getJob('job1')
    expect(recentServerJobs()).toEqual(['job3'])
  })

  it('renew an expired token once and repeat the call', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json([]))
    expect(await api.listJobs()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authHeader(0)).toBe('Bearer token-1')
    expect(authHeader(1)).toBe('Bearer fresh-token')
    expect(auth.getIdToken).toHaveBeenLastCalledWith(true)
    expect(auth.requestSignIn).not.toHaveBeenCalled()
  })

  it('ask the user to sign in again when the renewed token is refused, then retry', async () => {
    auth.requestSignIn.mockResolvedValueOnce(true)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(cloudTrack()))
    const track = await api.getTrack('0123456789ab')
    expect(track.title).toBe('Cloud song')
    expect(auth.requestSignIn).toHaveBeenCalledWith('expired')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('report unauthorized when the sign-in dialog is dismissed, without asking again right away', async () => {
    fetchMock.mockResolvedValue(unauthorized())
    await expect(api.getTrack('0123456789ab')).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(auth.requestSignIn).toHaveBeenCalledTimes(1)
    await expect(api.listJobs()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(auth.requestSignIn).toHaveBeenCalledTimes(1)
  })

  it('map the daily limit to quota_exceeded', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'Daily limit reached', code: 'quota_exceeded' }, 429))
    await expect(api.createJob('https://youtu.be/dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'quota_exceeded', status: 429 })
    // also without a JSON body
    fetchMock.mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
    await expect(api.createJob('https://youtu.be/dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'quota_exceeded' })
  })

  it('keep download_blocked for the "listen in the tab" fallback', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ...job, status: 'error', errorCode: 'download_blocked', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } }),
    )
    expect((await api.getJob('job1')).errorCode).toBe('download_blocked')
  })
})

// Admission refusals the admin causes (AC-18, AC-26, AC-27, AC-28): the server answers with a code and no
// quota is spent; the site words each one and still offers the browser (or the tab) instead.
describe('admission refusals', () => {
  const REFUSALS = [
    ['cloud_restricted', 403],
    ['analyses_paused', 503],
    ['youtube_disabled', 503],
    ['vocals_disabled', 503],
  ] as const

  it.each(REFUSALS)('keep %s from the server (status %i) instead of a generic network or http failure', async (code, status) => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'refused', code }, status))
    await expect(api.createJob('https://soundcloud.com/a/b')).rejects.toMatchObject({ code, status })
  })

  it('keep vocals_disabled when a vocals transcription is refused', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'off', code: 'vocals_disabled' }, 503))
    await expect(api.reanalyzeTrack('0123456789ab')).rejects.toMatchObject({ code: 'vocals_disabled' })
  })

  it('explain a restricted account with the support address and the browser, never the admin’s reason', () => {
    const uk = errorText('cloud_restricted', 'uk')
    expect(errorTitle('cloud_restricted', 'uk')).toBe('Хмарний аналіз для вашого акаунта обмежено')
    expect(uk).toContain(SUPPORT_EMAIL)
    expect(uk).toContain('браузері')
    expect(errorTitle('cloud_restricted', 'en')).toBe('Cloud analysis is restricted for your account')
    expect(errorText('cloud_restricted', 'en')).toContain(SUPPORT_EMAIL)
    expect(errorText('cloud_restricted', 'en')).toContain('browser')
  })

  it('show only our wording, not the server’s detail text', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'abuse reported by ops', code: 'cloud_restricted' }, 403))
    const err = await api.createJob('https://soundcloud.com/a/b').catch((e) => e)
    expect(errorText(err.code, 'uk')).not.toContain('abuse')
    expect(errorText(err.code, 'en')).not.toContain('abuse')
  })

  it.each([
    ['analyses_paused', 'uk', 'на паузі', 'браузері'],
    ['analyses_paused', 'en', 'paused', 'browser'],
    ['youtube_disabled', 'uk', 'YouTube', 'вкладці'],
    ['youtube_disabled', 'en', 'YouTube', 'tab'],
    ['vocals_disabled', 'uk', 'тимчасово недоступна', 'акорди'],
    ['vocals_disabled', 'en', 'unavailable', 'chords'],
  ] as const)('word %s in %s (%s … %s)', (code, lang, a, b) => {
    const text = errorText(code, lang)
    expect(text).toContain(a)
    expect(text.toLowerCase()).toContain(b.toLowerCase())
    expect(errorTitle(code, lang)).not.toBe(errorTitle('internal', lang))
  })
})

describe('cloud uploads', () => {
  it('go through Firebase Storage, then POST /jobs/storage with the recording’s link and offset', async () => {
    storage.uploadToStorage.mockImplementation(async (file: Blob, opts: { uid: string; onProgress?(l: number, t: number): void }) => {
      opts.onProgress?.(file.size / 2, file.size)
      return 'users/uid42/uploads/abc/Song.webm'
    })
    fetchMock.mockResolvedValueOnce(json(job, 201))
    const progress: number[] = []
    const file = new File(['0123456789'], 'Song.webm', { type: 'audio/webm' })
    const created = await api.uploadFile(file, (f) => progress.push(f), {
      meta: {
        title: 'Song',
        source: { type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        startOffset: 12.34567,
      },
    })
    expect(created.id).toBe('job1')
    expect(storage.uploadToStorage.mock.calls[0][1]).toMatchObject({ uid: 'uid42' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${CLOUD}/api/jobs/storage`)
    expect(init?.method).toBe('POST')
    expect(authHeader(0)).toBe('Bearer token-1')
    expect(JSON.parse(String(init?.body))).toEqual({
      path: 'users/uid42/uploads/abc/Song.webm',
      title: 'Song',
      source: { type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      startOffset: 12.346,
      origin: 'file',
    })
    expect(progress).toEqual([0.5, 1])
  })

  it('leave out empty fields of the storage job', () => {
    expect(api.storageJobBody('users/u/uploads/x/a.mp3')).toEqual({ path: 'users/u/uploads/x/a.mp3' })
    expect(api.storageJobBody('p', { title: '  ', startOffset: 0 })).toEqual({ path: 'p' })
  })

  it('say whether the file is a microphone recording or a file (origin hint, absent means file)', async () => {
    storage.uploadToStorage.mockResolvedValue('users/uid42/uploads/abc/a.mp3')
    fetchMock.mockImplementation(async () => json(job, 201))
    await api.uploadFile(new File(['x'], 'a.mp3'))
    await api.uploadFile(new File(['x'], 'rec.webm'), undefined, { meta: { title: 'Rec', origin: 'mic' } })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).origin).toBe('file')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).origin).toBe('mic')
  })

  it('send the origin hint with a direct multipart upload too', async () => {
    storage.uploadToStorage.mockRejectedValue(new Error('rules'))
    let sent: FormData | null = null
    class FakeXhr {
      status = 201
      statusText = 'Created'
      responseText = JSON.stringify(job)
      responseType = ''
      upload: { onprogress: unknown } = { onprogress: null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        return 'application/json'
      }
      abort() {}
      send(form: FormData) {
        sent = form
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    await api.uploadFile(new File(['x'], 'rec.webm'), undefined, { meta: { origin: 'mic' } })
    expect((sent as FormData | null)?.get('origin')).toBe('mic')
    await api.uploadFile(new File(['x'], 'a.mp3'))
    expect((sent as FormData | null)?.get('origin')).toBe('file')
  })

  it('need a signed-in user', async () => {
    auth.user = null
    await expect(api.uploadFile(new File(['x'], 'a.mp3'))).rejects.toMatchObject({ code: 'unauthorized' })
    expect(storage.uploadToStorage).not.toHaveBeenCalled()
  })

  it('can still analyze in this browser (daily limit reached)', async () => {
    const created = await api.uploadFile(new File(['abc'], 'Local.mp3', { type: 'audio/mpeg' }), undefined, { inBrowser: true })
    expect(created.id.startsWith('local-job-')).toBe(true)
    expect(storage.uploadToStorage).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('browser mode recordings of a video', () => {
  it('keep the video link and title', async () => {
    connect({ status: 'browser', backend: null, apiBase: null, serverOrigin: null, remote: false })
    const created = await api.uploadFile(new File(['tab-recording'], 'x.webm', { type: 'audio/webm' }), undefined, {
      meta: { title: 'Video title', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' } },
    })
    let done: Job | undefined
    for (let i = 0; i < 200 && !(done?.status === 'done' || done?.status === 'error'); i++) {
      await new Promise((r) => setTimeout(r, 1))
      done = getLocalJob(created.id)
    }
    expect(done?.status).toBe('done')
    const track = await api.getTrack(done?.trackId as string)
    expect(track.title).toBe('Video title')
    expect(track.source).toMatchObject({ type: 'youtube', videoId: 'dQw4w9WgXcQ' })
  })
})
