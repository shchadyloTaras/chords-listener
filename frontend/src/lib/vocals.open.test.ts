// @vitest-environment jsdom
// Opening a cloud song in the score view (a saved setting, so on every visit): the vocals part loads with
// `useVocals(track)` (components/chords/score/scoreData.ts). A song without vocals must not wake the cloud.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('./auth', async () => {
  const { create } = await import('zustand')
  return {
    useAuth: create<{ user: { uid: string; email: string | null } | null; ready: boolean }>()(() => ({ user: { uid: 'uid42', email: null }, ready: true })),
    getIdToken: async () => 'token-1',
    requestSignIn: async () => false,
  }
})

import { useConnection } from './serverMode'
import { resetVocals, useVocals, useVocalsStore } from './vocals'

const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
const fetchMock = vi.fn<typeof fetch>()
let root: Root | null = null

function ScoreVocals({ vocals }: { vocals: boolean }) {
  useVocals({ id: '0123456789ab', duration: 30, vocals })
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  resetVocals()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useConnection.setState({
    status: 'server',
    backend: 'cloud',
    apiBase: `${CLOUD}/api`,
    serverOrigin: CLOUD,
    remote: true,
    health: null,
    failure: null,
    probing: false,
    checkedAt: 1,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

it('a cloud song whose track says it has no vocals: opening it in the score view asks nothing', async () => {
  root = createRoot(document.createElement('div'))
  await act(async () => root?.render(createElement(ScoreVocals, { vocals: false })))
  await act(() => new Promise((r) => setTimeout(r, 20)))
  expect(useVocalsStore.getState().tracks['0123456789ab']).toEqual({ status: 'missing' })
  expect(fetchMock).not.toHaveBeenCalled()
})
