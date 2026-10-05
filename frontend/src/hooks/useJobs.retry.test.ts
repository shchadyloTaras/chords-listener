// Retrying an upload that the cloud refused for today's limit: the same file, analyzed in this browser.
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

const api = vi.hoisted(() => ({ uploadFile: vi.fn() }))
vi.mock('../lib/api', () => ({
  uploadFile: api.uploadFile,
  toApiError: (e: unknown) => e,
  getJob: vi.fn(),
  listJobs: vi.fn(),
  createJob: vi.fn(),
  reanalyzeTrack: vi.fn(),
}))

import { retryJob, uploadAndFollow } from './useJobs'

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
