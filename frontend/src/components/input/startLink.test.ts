// Starting a link per mode (owner decisions on guests): a guest never reaches a server — YouTube goes to
// "listen in the tab" where the browser can hear its tab, otherwise it needs an account; signed-in users
// and a local server get a job. Plus the link that waits for an account and is sent after signing in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../../types'

const auth = vi.hoisted(() => ({ user: null as { uid: string; email: string | null } | null }))
vi.mock('../../lib/auth', () => ({
  getIdToken: async () => 'token-1',
  requestSignIn: async () => false,
  useAuth: { getState: () => ({ user: auth.user, ready: true }), subscribe: () => () => undefined },
}))

const live = vi.hoisted(() => ({ canListenInTab: vi.fn<() => boolean>() }))
vi.mock('../../lib/live/capture', () => ({ canListenInTab: live.canListenInTab }))

// the real request (lib/api) without the job store's polling and navigation
vi.mock('../../hooks/useJobs', async () => {
  const api = await import('../../lib/api')
  return { submitUrl: (url: string) => api.createJob(url) }
})

const route = vi.hoisted(() => ({ navigate: vi.fn<(path: string) => void>() }))
vi.mock('../../hooks/useRoute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRoute')>()),
  navigate: route.navigate,
}))

import { useConnection, type ConnectionState } from '../../lib/serverMode'
import { startLink, submitAfterSignIn, submitWhenConnected } from './startLink'

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
const job: Job = { id: 'job1', status: 'queued', progress: 0, message: 'Queued', createdAt: '2026-10-05T10:00:00Z' }
const fetchMock = vi.fn<typeof fetch>()

function connect(patch: Partial<ConnectionState>) {
  useConnection.setState({ probing: false, failure: null, checkedAt: 1, health: null, permission: 'unsupported', ...patch })
}

const guest = () => connect({ status: 'browser', backend: null, apiBase: null, serverOrigin: null, remote: false })
const cloud = () => connect({ status: 'server', backend: 'cloud', apiBase: `${CLOUD}/api`, serverOrigin: CLOUD, remote: true })

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify(job), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  live.canListenInTab.mockReset().mockReturnValue(true)
  route.navigate.mockReset()
  auth.user = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  connect({ status: 'checking', backend: null, apiBase: null, serverOrigin: null, remote: false })
})

describe('startLink', () => {
  it('guest who can listen to the tab: plays the video on the capture page, no request', async () => {
    guest()
    expect(await startLink(VIDEO)).toEqual({ kind: 'capture', videoId: 'dQw4w9WgXcQ' })
    expect(route.navigate).toHaveBeenCalledWith('/listen/youtube/dQw4w9WgXcQ')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('guest on a phone / Safari / Firefox: YouTube needs an account, no request', async () => {
    guest()
    live.canListenInTab.mockReturnValue(false)
    expect(await startLink(VIDEO)).toEqual({ kind: 'account' })
    expect(route.navigate).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('guest with a link to another site: needs an account, even where the tab can be heard', async () => {
    guest()
    expect(await startLink('https://soundcloud.com/artist/song')).toEqual({ kind: 'account' })
    expect(route.navigate).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signed in: the cloud downloads the video (on any device)', async () => {
    cloud()
    live.canListenInTab.mockReturnValue(false)
    expect(await startLink(VIDEO)).toMatchObject({ kind: 'job', job: { id: 'job1' } })
    expect(fetchMock.mock.calls[0][0]).toBe(`${CLOUD}/api/jobs`)
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer token-1')
    expect(route.navigate).not.toHaveBeenCalled()
  })

  it('local server: it downloads the video, no account involved', async () => {
    connect({ status: 'server', backend: 'local', apiBase: '/api', serverOrigin: 'http://localhost:8765', remote: false })
    expect(await startLink(VIDEO)).toMatchObject({ kind: 'job', job: { id: 'job1' } })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBeNull()
  })

  it('passes other server errors on', async () => {
    cloud()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Busy', code: 'quota_exceeded' }), { status: 429 }))
    await expect(startLink(VIDEO)).rejects.toMatchObject({ code: 'quota_exceeded' })
    expect(route.navigate).not.toHaveBeenCalled()
  })
})

describe('submitWhenConnected (a link waiting for an account)', () => {
  it('is sent once, when signing in connects the cloud', () => {
    guest()
    const submit = vi.fn()
    submitWhenConnected(VIDEO, submit)
    connect({ probing: true })
    expect(submit).not.toHaveBeenCalled()
    cloud()
    expect(submit).toHaveBeenCalledExactlyOnceWith(VIDEO)
    // later updates (the cloud's health arriving, a re-probe) do not send it again
    connect({ checkedAt: 2 })
    cloud()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('is forgotten when cancelled first (dismissed, replaced, page left)', () => {
    guest()
    const submit = vi.fn()
    const cancel = submitWhenConnected(VIDEO, submit)
    cancel()
    cloud()
    expect(submit).not.toHaveBeenCalled()
  })

  it('is sent right away when a server is already connected', () => {
    cloud()
    const submit = vi.fn()
    submitWhenConnected(VIDEO, submit)
    expect(submit).toHaveBeenCalledExactlyOnceWith(VIDEO)
  })
})

describe('submitAfterSignIn (the capture page\'s video waiting for a sign-in)', () => {
  const ownServer = () =>
    connect({ status: 'server', backend: 'local', apiBase: 'http://localhost:8765/api', serverOrigin: 'http://localhost:8765', remote: true })

  it('is sent once the sign-in connects the cloud', () => {
    guest()
    const submit = vi.fn()
    const giveUp = vi.fn()
    submitAfterSignIn(VIDEO, submit, giveUp)
    auth.user = { uid: 'uid42', email: 'listener@example.com' }
    cloud()
    expect(submit).toHaveBeenCalledExactlyOnceWith(VIDEO)
    expect(giveUp).not.toHaveBeenCalled()
  })

  it('is not sent when the user\'s own / a local server connects instead (no sign-in)', () => {
    guest()
    const submit = vi.fn()
    const giveUp = vi.fn()
    submitAfterSignIn(VIDEO, submit, giveUp)
    ownServer()
    expect(submit).not.toHaveBeenCalled()
    expect(giveUp).toHaveBeenCalledOnce()
    // the wait is over: a later sign-in does not send it either
    auth.user = { uid: 'uid42', email: 'listener@example.com' }
    cloud()
    expect(submit).not.toHaveBeenCalled()
  })

  it('is forgotten when cancelled first (the page was left)', () => {
    guest()
    const submit = vi.fn()
    const cancel = submitAfterSignIn(VIDEO, submit, vi.fn())
    cancel()
    auth.user = { uid: 'uid42', email: 'listener@example.com' }
    cloud()
    expect(submit).not.toHaveBeenCalled()
  })
})
