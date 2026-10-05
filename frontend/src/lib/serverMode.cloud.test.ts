// The signed-in user's cloud (Cloud Run, min instances 0): any request wakes an instance that then bills for
// a while, so connecting asks nothing; the health check runs only when something needs it, and "waking" is
// shown only while the cloud is actually being asked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health } from '../types'

vi.mock('./auth', () => ({
  getIdToken: async () => 'token-1',
  requestSignIn: async () => false,
  useAuth: { getState: () => ({ user: { uid: 'uid42', email: null }, ready: true }), subscribe: () => () => undefined },
}))

import {
  cachedFeatures,
  cloudWaking,
  probeServer,
  refreshCloudHealth,
  useConnection,
  type ConnectionState,
} from './serverMode'

const HEALTH: Health = { ok: true, engine: { name: 'madmom', version: '1', features: { vocals: true } }, ytdlp: null, ffmpeg: true }
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useConnection.setState({ status: 'checking', backend: null, apiBase: null, serverOrigin: null, remote: false, health: null, failure: null, cloudBusy: false })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('connecting to the cloud', () => {
  it('asks the cloud nothing', async () => {
    expect(await probeServer()).toBe(true)
    const s = useConnection.getState()
    expect(s).toMatchObject({ status: 'server', backend: 'cloud', health: null })
    expect(fetchMock).not.toHaveBeenCalled()
    // nothing is waiting for the cloud: not "waking"
    expect(cloudWaking(s)).toBe(false)
  })
})

describe('the cloud health check', () => {
  it('is "waking" while it is under way, and keeps the features for next time', async () => {
    await probeServer()
    let answer: (r: Response) => void = () => undefined
    fetchMock.mockReturnValueOnce(new Promise((r) => (answer = r)))
    const done = refreshCloudHealth()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/health$/)
    expect(cloudWaking(useConnection.getState())).toBe(true)
    answer(json(HEALTH))
    await done
    expect(useConnection.getState()).toMatchObject({ health: HEALTH, cloudBusy: false })
    expect(cloudWaking(useConnection.getState())).toBe(false)
    expect(cachedFeatures()).toEqual({ vocals: true })
  })

  it('features seen last time are kept for a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await probeServer()
    fetchMock.mockResolvedValueOnce(json(HEALTH))
    await refreshCloudHealth()
    vi.setSystemTime(Date.now() + 24 * 3600_000 - 1000)
    expect(cachedFeatures()).toEqual({ vocals: true })
    vi.setSystemTime(Date.now() + 2000)
    expect(cachedFeatures()).toBeNull()
  })

  it('a failed check is not "waking" (the chip says the cloud is not answering)', async () => {
    await probeServer()
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))
    await refreshCloudHealth()
    expect(useConnection.getState()).toMatchObject({ failure: 'unreachable', cloudBusy: false })
    expect(cloudWaking(useConnection.getState())).toBe(false)
    expect(cachedFeatures()).toBeNull()
  })
})

describe('cloudWaking', () => {
  const cloud: Pick<ConnectionState, 'status' | 'backend' | 'health' | 'failure' | 'cloudBusy'> = {
    status: 'server',
    backend: 'cloud',
    health: null,
    failure: null,
    cloudBusy: true,
  }
  it.each([
    ['asked, no answer yet', cloud, true],
    ['never asked', { ...cloud, cloudBusy: false }, false],
    ['answered', { ...cloud, health: HEALTH }, false],
    ['not answering', { ...cloud, failure: 'unreachable' as const }, false],
    ['own server', { ...cloud, backend: 'local' as const }, false],
    ['guest', { ...cloud, status: 'browser' as const, backend: null }, false],
  ])('%s', (_name, s, waking) => {
    expect(cloudWaking(s)).toBe(waking)
  })
})
