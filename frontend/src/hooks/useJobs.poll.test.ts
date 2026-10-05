// How often running server jobs are polled, and when a page load asks the server for its job list: only when
// a job started on this device may still be running (each request wakes the cloud).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../types'

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

// settings are persisted: give the store a storage to write to (also where recent jobs are remembered)
vi.hoisted(() => vi.stubGlobal('localStorage', memoryStorage()))

vi.mock('../lib/auth', () => ({
  getIdToken: async () => null,
  requestSignIn: async () => false,
  useAuth: { getState: () => ({ user: null, ready: true }), subscribe: () => () => undefined },
}))

vi.mock('./useRoute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useRoute')>()),
  currentPath: () => '/',
  navigate: vi.fn(),
}))

const api = vi.hoisted(() => ({ getJob: vi.fn(), listJobs: vi.fn() }))
vi.mock('../lib/api', () => ({
  uploadFile: vi.fn(),
  toApiError: (e: unknown) => e,
  getJob: api.getJob,
  listJobs: api.listJobs,
  createJob: vi.fn(),
  reanalyzeTrack: vi.fn(),
}))

import { recentServerJobs, rememberServerJob } from '../lib/cloud/activity'
import { ensureJob, JOB_POLL_MS, syncServerJobs, useJobs } from './useJobs'

const running = (id = 'j1'): Job => ({
  id,
  status: 'analyzing',
  progress: 0.5,
  message: 'Analyzing',
  createdAt: '2026-10-05T10:00:00Z',
  source: { type: 'file', filename: 'song.mp3' },
})
const done = (id = 'j1'): Job => ({ ...running(id), status: 'done', progress: 1, trackId: 't1' })

const doc = { hidden: false }

beforeEach(() => {
  vi.stubGlobal('window', globalThis) // toasts and polling use window.setTimeout
  vi.stubGlobal('document', doc)
  doc.hidden = false
  localStorage.clear()
  useJobs.setState({ jobs: {}, acknowledged: {}, uploads: [] })
  api.getJob.mockReset()
  api.listJobs.mockReset().mockResolvedValue([])
  vi.useFakeTimers()
})

afterEach(async () => {
  // let the job finish so that no poll is left scheduled for the next test
  api.getJob.mockReset().mockImplementation(async (id: string) => done(id))
  await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
})

/** Starts following a running job; resolves once its first state is known (not a poll yet). */
async function follow(id = 'j1') {
  api.getJob.mockResolvedValueOnce(running(id))
  await ensureJob(id)
  api.getJob.mockClear()
}

describe('job polling', () => {
  it('is calm: a second while visible, 3 s hidden, 5 s when the cloud wants a new sign-in', () => {
    expect(JOB_POLL_MS).toEqual({ visible: 1000, hidden: 3000, signedOut: 5000 })
  })

  it('first polls after 600 ms, then every second while the page is visible', async () => {
    await follow()
    api.getJob.mockResolvedValue(running())
    await vi.advanceTimersByTimeAsync(599)
    expect(api.getJob).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS.visible - 1)
    expect(api.getJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getJob).toHaveBeenCalledTimes(2)
  })

  it('every 3 s in a hidden tab', async () => {
    await follow()
    api.getJob.mockResolvedValue(running())
    doc.hidden = true
    await vi.advanceTimersByTimeAsync(600)
    expect(api.getJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS.hidden - 1)
    expect(api.getJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getJob).toHaveBeenCalledTimes(2)
  })

  it('every 5 s while the cloud asks for a new sign-in', async () => {
    await follow()
    api.getJob.mockRejectedValue({ code: 'unauthorized', message: 'Sign in' })
    await vi.advanceTimersByTimeAsync(600)
    expect(api.getJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS.signedOut - 1)
    expect(api.getJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getJob).toHaveBeenCalledTimes(2)
  })

  it('a finished job is no longer looked for after a reload', async () => {
    rememberServerJob('j1')
    await follow()
    api.getJob.mockResolvedValue(done())
    await vi.advanceTimersByTimeAsync(600)
    expect(useJobs.getState().jobs.j1.status).toBe('done')
    expect(recentServerJobs()).toEqual([])
  })
})

describe('syncServerJobs (page load, another server)', () => {
  it('asks nothing when no job was started on this device lately', async () => {
    await syncServerJobs()
    expect(api.listJobs).not.toHaveBeenCalled()
  })

  it('picks up a job started here before the reload, and forgets the ones that are over', async () => {
    rememberServerJob('j1')
    rememberServerJob('j2')
    api.listJobs.mockResolvedValue([running('j1'), done('j2')])
    await syncServerJobs()
    expect(api.listJobs).toHaveBeenCalledTimes(1)
    expect(Object.keys(useJobs.getState().jobs)).toEqual(['j1'])
    expect(recentServerJobs()).toEqual(['j1'])
  })

  it('keeps them when the server cannot be asked right now', async () => {
    rememberServerJob('j1')
    api.listJobs.mockRejectedValue({ code: 'network', message: 'offline' })
    await syncServerJobs()
    expect(recentServerJobs()).toEqual(['j1'])
  })
})
