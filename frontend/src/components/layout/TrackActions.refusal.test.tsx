// @vitest-environment jsdom
// AC-18 / AC-26: "Re-analyze" refused by the administrator (restricted account, paused analyses) toasts the
// cloud's explanation — a restriction names the support e-mail.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() =>
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
)
const jobs = vi.hoisted(() => ({ reanalyze: vi.fn() }))
vi.mock('../../hooks/useJobs', () => ({ reanalyze: jobs.reanalyze }))
vi.mock('../history/tracksStore', () => ({ scheduleDelete: vi.fn() }))

import { ApiError } from '../../lib/api'
import { SUPPORT_EMAIL } from '../../i18n/cloud'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { HeaderMenu } from './TrackActions'

let root: Root
let host: HTMLDivElement
const track = { id: 't1', title: 'Song', source: { type: 'file' } } as unknown as Track

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('CSS', { escape: (v: string) => v }) // jsdom has none; the menu focuses its trigger on close
  useApp.setState({ lang: 'en', toasts: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<HeaderMenu track={track} demo={false} withSettings={false} onHelp={() => undefined} />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function reanalyzeRefused(code: 'cloud_restricted' | 'analyses_paused') {
  jobs.reanalyze.mockRejectedValueOnce(new ApiError('refused', code, 403))
  act(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click())
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => /detect again/i.test(e.textContent ?? ''))
  await act(async () => item!.click())
}

describe('Re-analyze refused', () => {
  it('a restricted account: the toast names the support e-mail', async () => {
    await reanalyzeRefused('cloud_restricted')
    const toast = useApp.getState().toasts.at(-1)!
    expect(toast.kind).toBe('error')
    expect(toast.message).toContain(SUPPORT_EMAIL)
  })
  it('paused analyses: the toast says so', async () => {
    await reanalyzeRefused('analyses_paused')
    expect(useApp.getState().toasts.at(-1)!.message).toMatch(/paused/i)
  })
})
