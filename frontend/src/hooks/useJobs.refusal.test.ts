// AC-18 / AC-26: a cloud upload the administrator refuses (restricted account, paused analyses) toasts the
// explanation (with the support e-mail for a restriction) and offers to analyze the same file in this browser.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() =>
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
)
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
const api = vi.hoisted(() => ({ uploadFile: vi.fn() }))
vi.mock('../lib/api', () => ({
  uploadFile: api.uploadFile,
  toApiError: (e: unknown) => e,
  getJob: vi.fn(),
  listJobs: vi.fn(),
  createJob: vi.fn(),
  reanalyzeTrack: vi.fn(),
}))

import { SUPPORT_EMAIL } from '../i18n/cloud'
import { useApp } from '../store'
import { submitFile } from './useJobs'

const file = new File(['x'], 'song.mp3', { type: 'audio/mpeg' })
const lastToast = () => useApp.getState().toasts.at(-1)!

beforeEach(() => {
  vi.stubGlobal('window', globalThis)
  useApp.setState({ lang: 'en', toasts: [] })
  api.uploadFile.mockReset()
})

describe('submitFile refused by the administrator', () => {
  it('a restricted account: the explanation names the support e-mail, and "In the browser" retries here', async () => {
    api.uploadFile.mockRejectedValueOnce({ code: 'cloud_restricted' })
    expect(await submitFile(file)).toBeNull()
    const toast = lastToast()
    expect(toast.kind).toBe('error')
    expect(toast.message).toContain(SUPPORT_EMAIL)
    expect(toast.action?.label).toBe('In the browser')

    api.uploadFile.mockRejectedValueOnce({ code: 'aborted' })
    toast.action!.run()
    await vi.waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2))
    expect(api.uploadFile.mock.calls[1][2]).toMatchObject({ inBrowser: true })
  })

  it('paused analyses: the same offer', async () => {
    api.uploadFile.mockRejectedValueOnce({ code: 'analyses_paused' })
    await submitFile(file)
    expect(lastToast().action?.label).toBe('In the browser')
  })

  it('refused again in the browser run: no second offer', async () => {
    api.uploadFile.mockRejectedValueOnce({ code: 'cloud_restricted' })
    await submitFile(file, undefined, { inBrowser: true })
    expect(lastToast().action).toBeUndefined()
  })
})
