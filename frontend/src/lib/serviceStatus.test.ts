// The public service status (publicStatus/current: the maintenance banner and the service switches) is read
// straight from Firestore, at most once per 5 minutes, and never from the cloud server: showing a banner must
// not wake it (ADR-0005, AC-27, AC-29). Firebase is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  db: { type: 'firestore' },
  doc: vi.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  getDoc: vi.fn<(ref: unknown) => Promise<{ exists: () => boolean; data: () => unknown }>>(),
}))
vi.mock('./firestore', () => ({ db: fs.db }))
vi.mock('firebase/firestore', () => ({ doc: fs.doc, getDoc: fs.getDoc }))

import {
  STATUS_TTL_MS,
  bannerText,
  loadServiceStatus,
  parseServiceStatus,
  resetServiceStatusForTests,
  useServiceStatus,
  youtubeEnabled,
} from './serviceStatus'

const ALL_ON = { analysesPaused: false, youtubeEnabled: true, vocalsEnabled: true }
const fetchMock = vi.fn<typeof fetch>()

function published(data: unknown) {
  fs.getDoc.mockResolvedValue({ exists: () => data !== undefined, data: () => data })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  fs.getDoc.mockReset()
  fs.doc.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetServiceStatusForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('parseServiceStatus', () => {
  it('reads the banner and the switches', () => {
    const s = parseServiceStatus({
      banner: { enabled: true, uk: 'Технічні роботи', en: 'Maintenance' },
      switches: { analysesPaused: true, youtubeEnabled: false, vocalsEnabled: true },
      updatedAt: 'ignored',
    })
    expect(s).toEqual({
      banner: { enabled: true, uk: 'Технічні роботи', en: 'Maintenance' },
      switches: { analysesPaused: true, youtubeEnabled: false, vocalsEnabled: true },
    })
  })

  it('a missing or malformed document shows nothing and switches nothing off', () => {
    for (const bad of [undefined, null, 'x', 7, [], { banner: 'x', switches: 3 }, { banner: { enabled: 'yes' } }]) {
      expect(parseServiceStatus(bad)).toEqual({ banner: null, switches: ALL_ON })
    }
  })

  it('a switch that is not a boolean stays on (never lock people out on a bad value)', () => {
    expect(parseServiceStatus({ switches: { youtubeEnabled: 'no', vocalsEnabled: false } }).switches).toEqual({
      ...ALL_ON,
      vocalsEnabled: false,
    })
  })
})

describe('bannerText', () => {
  it('is the text in the interface language', () => {
    const status = parseServiceStatus({ banner: { enabled: true, uk: 'Технічні роботи', en: 'Maintenance' } })
    expect(bannerText(status, 'uk')).toBe('Технічні роботи')
    expect(bannerText(status, 'en')).toBe('Maintenance')
  })
  it('is null when the banner is off, absent or the text is blank', () => {
    expect(bannerText(parseServiceStatus({ banner: { enabled: false, uk: 'a', en: 'b' } }), 'en')).toBeNull()
    expect(bannerText(parseServiceStatus({}), 'uk')).toBeNull()
    expect(bannerText(parseServiceStatus({ banner: { enabled: true, uk: '  ', en: 'b' } }), 'uk')).toBeNull()
  })
})

describe('loadServiceStatus', () => {
  it('reads publicStatus/current from Firestore and keeps it in the store, with no request to any server', async () => {
    published({ banner: { enabled: true, uk: 'Технічні роботи', en: 'Maintenance' }, switches: { ...ALL_ON, youtubeEnabled: false } })
    const status = await loadServiceStatus()
    expect(fs.doc).toHaveBeenCalledWith(fs.db, 'publicStatus', 'current')
    expect(status.banner?.en).toBe('Maintenance')
    expect(useServiceStatus.getState().status).toEqual(status)
    expect(youtubeEnabled()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads at most once per 5 minutes, then again', async () => {
    published({ banner: { enabled: true, uk: 'a', en: 'b' } })
    await loadServiceStatus()
    await loadServiceStatus()
    vi.advanceTimersByTime(STATUS_TTL_MS - 1000)
    await loadServiceStatus()
    expect(fs.getDoc).toHaveBeenCalledTimes(1)

    published({ banner: { enabled: false, uk: 'a', en: 'b' } })
    vi.advanceTimersByTime(1000)
    const next = await loadServiceStatus()
    expect(fs.getDoc).toHaveBeenCalledTimes(2)
    expect(next.banner?.enabled).toBe(false)
    expect(useServiceStatus.getState().status.banner?.enabled).toBe(false)
  })

  it('callers at the same moment share one read', async () => {
    published({})
    await Promise.all([loadServiceStatus(), loadServiceStatus(), loadServiceStatus()])
    expect(fs.getDoc).toHaveBeenCalledTimes(1)
  })

  it('a missing document is the default: no banner, everything on', async () => {
    published(undefined)
    expect(await loadServiceStatus()).toEqual({ banner: null, switches: ALL_ON })
  })

  it('a failed read is not an error for the site: the last known status stays, and it is retried within a minute', async () => {
    published({ banner: { enabled: true, uk: 'a', en: 'b' } })
    await loadServiceStatus()
    vi.advanceTimersByTime(STATUS_TTL_MS)
    fs.getDoc.mockRejectedValue(new Error('offline'))
    const kept = await loadServiceStatus()
    expect(kept.banner?.en).toBe('b')
    await loadServiceStatus()
    expect(fs.getDoc).toHaveBeenCalledTimes(2)
    published({})
    vi.advanceTimersByTime(60_000)
    expect((await loadServiceStatus()).banner).toBeNull()
    expect(fs.getDoc).toHaveBeenCalledTimes(3)
  })
})

describe('youtubeEnabled', () => {
  it('is on until the site has learnt otherwise', () => {
    expect(youtubeEnabled()).toBe(true)
  })
})
