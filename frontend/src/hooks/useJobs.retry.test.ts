// Retrying an upload that the cloud refused for today's limit: the same file, analyzed in this browser. Retrying
// a YouTube job on the cloud: the video is listened to here (the cloud is never sent YouTube links).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../types'

// settings are persisted: give the store a storage to write to
vi.hoisted(() =>
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
)

vi.mock('../lib/auth', () => ({
  getIdToken: async () => null,
  requestSignIn: async () => false,
  useAuth: { getState: () => ({ user: null, ready: true }), subscribe: () => () => undefined },
}))

// the job store navigates and toasts; the route is not what is under test
vi.mock('./useRoute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useRoute')>()),
  currentPath: () => '/',
  navigate: vi.fn(),
}))

const api = vi.hoisted(() => ({ uploadFile: vi.fn(), createJob: vi.fn() }))
vi.mock('../lib/api', () => ({
  uploadFile: api.uploadFile,
  toApiError: (e: unknown) => e,
  getJob: vi.fn(),
  listJobs: vi.fn(),
  createJob: api.createJob,
  reanalyzeTrack: vi.fn(),
}))

import { useConnection, type ConnectionState } from '../lib/serverMode'
import { retryJob, uploadAndFollow } from './useJobs'
import { navigate } from './useRoute'

// done, so following it opens the track and starts no polling
const stored: Job = {
  id: 'j1',
  status: 'done',
  progress: 1,
  message: 'Done',
  trackId: 't1',
  createdAt: '2026-10-05T10:00:00Z',
  source: { type: 'file', filename: 'song.mp3' },
}
const file = new File(['x'], 'song.mp3', { type: 'audio/mpeg' })

beforeEach(async () => {
  vi.stubGlobal('window', globalThis) // toasts auto-dismiss with window.setTimeout
  api.uploadFile.mockReset().mockResolvedValue(stored)
  await uploadAndFollow(file) // remembers the file for "Retry"
  api.uploadFile.mockClear()
  api.createJob.mockReset().mockResolvedValue({ ...stored, id: 'j3' })
  vi.mocked(navigate).mockClear()
})

describe('retryJob', () => {
  it('sends the remembered file again', async () => {
    expect(await retryJob(stored)).toBe(true)
    expect(api.uploadFile).toHaveBeenCalledTimes(1)
    expect(api.uploadFile.mock.calls[0][0]).toBe(file)
    expect(api.uploadFile.mock.calls[0][2]).toMatchObject({ inBrowser: undefined })
  })

  it('analyzes it in this browser when asked', async () => {
    expect(await retryJob(stored, { inBrowser: true })).toBe(true)
    expect(api.uploadFile.mock.calls[0][2]).toMatchObject({ inBrowser: true })
  })

  it('says so when the file is no longer in memory', async () => {
    await retryJob(stored) // the file is handed over to the new upload
    api.uploadFile.mockReset().mockResolvedValue({ ...stored, id: 'j2' })
    expect(await retryJob({ ...stored, id: 'unknown' })).toBe(false)
    expect(api.uploadFile).not.toHaveBeenCalled()
  })
})

describe('retryJob, a link', () => {
  const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  const failed = (source: Job['source']): Job => ({ ...stored, id: 'y1', status: 'error', errorCode: 'download_failed', trackId: null, source })
  const connect = (patch: Partial<ConnectionState>) =>
    useConnection.setState({ probing: false, failure: null, checkedAt: 1, health: null, permission: 'unsupported', ...patch })
  const cloud = () => connect({ status: 'server', backend: 'cloud', apiBase: 'https://api.example.run.app/api', remote: true })

  it('a YouTube video on the cloud: opens it on the capture page, nothing is sent', async () => {
    cloud()
    expect(await retryJob(failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: VIDEO }))).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/listen/youtube/dQw4w9WgXcQ')
    expect(api.createJob).not.toHaveBeenCalled()
  })

  it('the video the job knows wins over what its link says', async () => {
    cloud()
    expect(await retryJob(failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/playlist?list=PL1' }))).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/listen/youtube/dQw4w9WgXcQ')
    expect(api.createJob).not.toHaveBeenCalled()
  })

  it('a YouTube page that is not one video, on the cloud: nothing is sent, nothing to retry', async () => {
    cloud()
    expect(await retryJob(failed({ type: 'url', url: 'https://www.youtube.com/playlist?list=PL1' }))).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(api.createJob).not.toHaveBeenCalled()
  })

  it('a local server downloads the video again', async () => {
    connect({ status: 'server', backend: 'local', apiBase: '/api', remote: false })
    expect(await retryJob(failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: VIDEO }))).toBe(true)
    expect(api.createJob).toHaveBeenCalledWith(VIDEO, undefined, undefined)
  })
})
