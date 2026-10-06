// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Track } from '../../../types'

const notes = vi.hoisted(() => ({ useTrackNotes: vi.fn() }))
vi.mock('../../../lib/auth', async () => {
  const { create } = await import('zustand')
  return { useAuth: create(() => ({ user: null, ready: true })), getIdToken: async () => null, requestSignIn: async () => false }
})
// the service's store and key, without the transcription itself (useTrackNotes records what the view asks for)
vi.mock('../../../lib/transcription', async () => {
  const { create } = await import('zustand')
  return {
    notesKey: (id: string, source = 'mix') => (source === 'mix' ? id : `${id}#${source}`),
    useNotesStore: create(() => ({ tracks: {} })),
    useTrackNotes: notes.useTrackNotes,
  }
})

import { notesKey, useNotesStore, type NotesState } from '../../../lib/transcription'
import { usePianoNotes } from './pianoNotes'

const track = { id: 'aaaaaaaaaaaa', audioUrl: '/api/tracks/aaaaaaaaaaaa/audio', duration: 30, stems: ['instruments'] } as unknown as Track
const KEY = notesKey(track.id, 'instruments')
const COMPUTING: NotesState = { status: 'computing', stage: 'model', progress: 0.6, found: 120, backend: 'webgl' }

let root: Root | null = null

function Probe({ start }: { start?: boolean }) {
  usePianoNotes(track, { start })
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useNotesStore.setState({ tracks: {} })
  notes.useTrackNotes.mockReset().mockReturnValue({ status: 'idle' })
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
})

const render = (start?: boolean) => act(() => root!.render(createElement(Probe, { start })))
const setNotes = (state: NotesState) => act(() => useNotesStore.setState({ tracks: { [KEY]: state } }))
/** the track the view last asked notes for (null = none: nothing started or held) */
const asked = () => notes.useTrackNotes.mock.lastCall?.[0] ?? null

it('asks for the notes (transcribing them if needed) from the instruments stem', () => {
  render()
  expect(asked()).toBe(track)
  expect(notes.useTrackNotes.mock.lastCall?.[1]).toMatchObject({ source: 'instruments' })
})

it('start: false never starts a transcription, but keeps holding one that is already running', () => {
  render(false)
  expect(asked()).toBeNull()
  // a running transcription (started at another level, or by the live piano) is not thrown away
  setNotes({ status: 'loading' })
  expect(asked()).toBe(track)
  setNotes(COMPUTING)
  expect(asked()).toBe(track)
  // done: the notes stay in memory for the next level, nothing more to hold
  setNotes({ status: 'ready', index: null, engine: 'test', saved: true, stats: null, source: 'instruments' } as unknown as NotesState)
  expect(asked()).toBeNull()
  setNotes({ status: 'error', code: 'failed', message: 'x' })
  expect(asked()).toBeNull()
})
