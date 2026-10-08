// @vitest-environment jsdom
// "Розібрати акорди" refused by the cloud: a cloud that cannot download fragments (unavailable) or a guest
// (server_required) is sent on to the capture page, any other error is toasted - but only while the user is still
// on the picker; once they left while the request was pending, nothing pulls them back.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ClientErrorCode } from '../../lib/api'
import { currentPath, paths } from '../../hooks/useRoute'
import { useApp } from '../../store'
import { ClipPage } from './ClipPage'

const { submitClip } = vi.hoisted(() => ({ submitClip: vi.fn() }))
vi.mock('../../hooks/useJobs', async (importOriginal) => ({ ...(await importOriginal<object>()), submitClip }))
// the player never loads: the picker's own buttons are what is under test
vi.mock('../player/sources/youtubeApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadYouTubeApi: () => new Promise(() => {}),
}))

const VIDEO = 'dQw4w9WgXcQ'
const PICKER = paths.clip(VIDEO, { t: 72 })

let root: Root
let host: HTMLDivElement
let toast: ReturnType<typeof vi.fn>

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  window.location.hash = `#${PICKER}`
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  toast = vi.fn()
  useApp.setState({ lang: 'uk', toast: toast as never })
  submitClip.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(ClipPage, { videoId: VIDEO, start: 72 })))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Presses "analyze", with the request still pending; returns how to fail it. */
function analyze(): (code: ClientErrorCode) => Promise<void> {
  let reject!: (e: unknown) => void
  submitClip.mockReturnValue(new Promise((_, rej) => (reject = rej)))
  act(() => host.querySelector<HTMLElement>('[data-tour="clip.analyze"]')!.click())
  expect(submitClip).toHaveBeenCalledWith(VIDEO, 72)
  return (code) => act(async () => reject(new ApiError('refused', code)))
}

const leave = () => {
  window.location.hash = '#/'
}

describe('a fragment the cloud refused', () => {
  it('unavailable: the capture page, blocked, from the same place', async () => {
    const fail = analyze()
    await fail('unavailable')
    expect(currentPath()).toBe(paths.capture(VIDEO, { blocked: true, t: 72 }))
    expect(toast).not.toHaveBeenCalled()
  })

  it('a guest (server_required): the capture page, not blocked', async () => {
    const fail = analyze()
    await fail('server_required')
    expect(currentPath()).toBe(paths.capture(VIDEO, { t: 72 }))
    expect(toast).not.toHaveBeenCalled()
  })

  it('another error: a toast, and the picker stays', async () => {
    const fail = analyze()
    await fail('download_blocked')
    expect(currentPath()).toBe(PICKER)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![1]).toBe('error')
  })

  it.each(['unavailable', 'server_required', 'download_blocked'] as const)(
    '%s after the user left the picker: no redirect, no toast',
    async (code) => {
      const fail = analyze()
      leave()
      await fail(code)
      expect(currentPath()).toBe('/')
      expect(toast).not.toHaveBeenCalled()
    },
  )

  it('the button is usable again after a refusal', async () => {
    const fail = analyze()
    leave()
    await fail('unavailable')
    expect(host.querySelector<HTMLButtonElement>('[data-tour="clip.analyze"]')!.disabled).toBe(false)
  })
})
