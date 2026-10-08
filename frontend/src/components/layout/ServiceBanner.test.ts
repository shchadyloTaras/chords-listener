// @vitest-environment jsdom
// The maintenance banner (AC-29): a guest sees it in the interface language, as plain text, and opening the
// site asks no server for it (only Firestore's public status document, at most once per 5 minutes).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  doc: vi.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  getDoc: vi.fn<(ref: unknown) => Promise<{ exists: () => boolean; data: () => unknown }>>(),
}))
vi.mock('../../lib/firestore', () => ({ db: {} }))
vi.mock('firebase/firestore', () => ({ doc: fs.doc, getDoc: fs.getDoc }))
// the hosted site: the banner is read there (a local server's own app has no cloud to announce)
vi.mock('../../lib/serverMode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/serverMode')>()), HOSTED: true }))

import { STATUS_TTL_MS, resetServiceStatusForTests } from '../../lib/serviceStatus'
import { useApp } from '../../store'
import { ServiceBanner } from './ServiceBanner'

let root: Root
let host: HTMLDivElement
const fetchMock = vi.fn<typeof fetch>()

function publish(banner: { enabled: boolean; uk: string; en: string } | undefined) {
  fs.getDoc.mockResolvedValue({ exists: () => true, data: () => ({ banner, switches: { youtubeEnabled: true } }) })
}

/** A visit: the banner is mounted and Firestore's answer arrives. */
async function visit() {
  await act(async () => {
    root.render(createElement(ServiceBanner))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  fs.getDoc.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetServiceStatusForTests()
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ServiceBanner', () => {
  it('a guest sees the banner in the interface language, and no request goes to any server', async () => {
    publish({ enabled: true, uk: 'Технічні роботи до 18:00', en: 'Maintenance until 6 pm' })
    await visit()
    expect(host.textContent).toContain('Технічні роботи до 18:00')
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    act(() => useApp.setState({ lang: 'en' }))
    expect(host.textContent).toContain('Maintenance until 6 pm')
    expect(host.textContent).not.toContain('Технічні')

    expect(fs.getDoc).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the text as plain text, never as markup', async () => {
    publish({ enabled: true, uk: '<b>Увага</b> <img src=x onerror=alert(1)>', en: 'x' })
    await visit()
    expect(host.textContent).toContain('<b>Увага</b> <img src=x onerror=alert(1)>')
    expect(host.querySelector('b, img')).toBeNull()
  })

  it('shows nothing when there is no banner', async () => {
    publish(undefined)
    await visit()
    expect(host.textContent).toBe('')
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is gone for the next visit within 5 minutes of the admin switching it off', async () => {
    publish({ enabled: true, uk: 'Технічні роботи', en: 'Maintenance' })
    await visit()
    expect(host.textContent).toContain('Технічні роботи')

    publish({ enabled: false, uk: 'Технічні роботи', en: 'Maintenance' })
    act(() => root.unmount())
    root = createRoot(host)
    vi.setSystemTime(Date.now() + STATUS_TTL_MS)
    await visit()
    expect(host.textContent).toBe('')
    expect(fs.getDoc).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
