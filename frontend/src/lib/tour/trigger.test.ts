// The auto-start gate (not before ready, not while anything else is open or busy, 500 ms after the last
// condition clears, never once seen) and which tour the «Інструкція» entries open on each screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Route } from '../../hooks/useRoute'
import type { NotesState } from '../transcription'
import {
  captureReady,
  createAutoStart,
  gateOpen,
  guideAvailable,
  homeReady,
  keysNotesReady,
  libraryState,
  listenReady,
  reopenTours,
  tourRouteKey,
  type GateInput,
} from './trigger'

const QUIET: GateInput = {
  seen: false,
  ready: true,
  running: false,
  modal: false,
  menu: false,
  expanded: false,
  typing: false,
  playing: false,
  recording: false,
  hidden: false,
  blocked: false,
}

const home: Route = { name: 'home' }
const listen: Route = { name: 'listen', source: null, title: null }
const capture = (blocked: boolean): Route => ({ name: 'capture', videoId: 'dQw4w9WgXcQ', blocked, start: null })
const track: Route = { name: 'track', id: 't1' }
const demo: Route = { name: 'demo' }
const job: Route = { name: 'job', id: 'j1' }
const notFound: Route = { name: 'notFound' }

describe('the gate', () => {
  it('opens on a ready, quiet, unseen screen', () => {
    expect(gateOpen(QUIET)).toBe(true)
  })

  it.each([
    ['not ready', { ready: false }],
    ['already seen', { seen: true }],
    ['another tour running', { running: true }],
    ['an aria-modal dialog', { modal: true }],
    ['a menu', { menu: true }],
    ['an expanded control (an anchored panel)', { expanded: true }],
    ['focus in a text field', { typing: true }],
    ['the song playing', { playing: true }],
    ['a recording running', { recording: true }],
    ['the page hidden', { hidden: true }],
    ['a screen holding it back (a link on its way)', { blocked: true }],
  ] as const)('stays shut: %s', (_, change) => {
    expect(gateOpen({ ...QUIET, ...change })).toBe(false)
  })
})

describe('the 500 ms auto-start', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts 500 ms after the gate opens, waits again when it shuts, and starts once', () => {
    const start = vi.fn(() => 'started' as const)
    const auto = createAutoStart(start)
    auto.update(true)
    vi.advanceTimersByTime(499)
    auto.update(false)
    vi.advanceTimersByTime(1000)
    expect(start).not.toHaveBeenCalled()
    auto.update(true)
    vi.advanceTimersByTime(250)
    auto.update(true) // a later check while waiting does not restart the wait
    vi.advanceTimersByTime(250)
    expect(start).toHaveBeenCalledTimes(1)
    auto.update(true)
    vi.advanceTimersByTime(2000)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('tries again after "busy" (another tour won the race) and gives up after "empty"', () => {
    const results = ['busy', 'empty'] as const
    let call = 0
    const start = vi.fn(() => results[call++])
    const auto = createAutoStart(start)
    auto.update(true)
    vi.advanceTimersByTime(500)
    auto.update(true)
    vi.advanceTimersByTime(500)
    auto.update(true)
    vi.advanceTimersByTime(2000)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels a pending start', () => {
    const start = vi.fn(() => 'started' as const)
    const auto = createAutoStart(start)
    auto.update(true)
    auto.dispose()
    vi.advanceTimersByTime(1000)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('re-opening', () => {
  it("runs the current screen's tour", () => {
    expect(reopenTours(home, { view: 'sheet', keysPanel: false })).toEqual(['home'])
    expect(reopenTours(listen, { view: 'sheet', keysPanel: false })).toEqual(['listen'])
    expect(reopenTours(capture(false), { view: 'sheet', keysPanel: false })).toEqual(['capture'])
    expect(reopenTours(capture(true), { view: 'sheet', keysPanel: true })).toEqual(['capture'])
  })

  it.each([
    ['sheet', false, ['song']],
    ['timeline', false, ['song']],
    ['score', false, ['score']],
    ['sheet', true, ['song', 'keys']],
    ['timeline', true, ['song', 'keys']],
    ['score', true, ['score', 'keys']],
  ] as const)('track and demo, view %s, live keys %s → %j', (view, keysPanel, tours) => {
    expect(reopenTours(track, { view, keysPanel })).toEqual(tours)
    expect(reopenTours(demo, { view, keysPanel })).toEqual(tours)
  })

  it('has no tour on the processing and not-found pages', () => {
    expect(reopenTours(job, { view: 'sheet', keysPanel: true })).toEqual([])
    expect(reopenTours(notFound, { view: 'sheet', keysPanel: true })).toEqual([])
  })

  it('shows the entries where a tour exists, and on a song page only once it has loaded', () => {
    expect(guideAvailable(home, false)).toBe(true)
    expect(guideAvailable(listen, false)).toBe(true)
    expect(guideAvailable(capture(false), false)).toBe(true)
    expect(guideAvailable(track, false)).toBe(false)
    expect(guideAvailable(track, true)).toBe(true)
    expect(guideAvailable(demo, true)).toBe(true)
    expect(guideAvailable(job, true)).toBe(false)
    expect(guideAvailable(notFound, true)).toBe(false)
  })

  it('names a screen by its route (a different song or video is a different screen)', () => {
    expect(tourRouteKey(track)).toBe('track:t1')
    expect(tourRouteKey(capture(false))).toBe('capture:dQw4w9WgXcQ')
    expect(tourRouteKey(listen)).toBe('listen')
    expect(tourRouteKey(home)).toBe('home')
  })
})

describe('Home readiness', () => {
  it('the library: loading, failed, empty (also when every song waits for its undo) or with songs', () => {
    expect(libraryState(null, null, {})).toBe('loading')
    expect(libraryState(null, 'network', {})).toBe('failed')
    expect(libraryState([], null, {})).toBe('empty')
    expect(libraryState([{ id: 'a' }], null, { a: true })).toBe('empty')
    expect(libraryState([{ id: 'a' }, { id: 'b' }], null, { a: true })).toBe('list')
  })

  it('ready once the connection is settled, auth is ready and the library loaded or failed', () => {
    expect(homeReady({ settled: true, authReady: true, library: 'empty' })).toBe(true)
    expect(homeReady({ settled: true, authReady: true, library: 'failed' })).toBe(true)
    expect(homeReady({ settled: true, authReady: true, library: 'loading' })).toBe(false)
    expect(homeReady({ settled: false, authReady: true, library: 'list' })).toBe(false)
    expect(homeReady({ settled: true, authReady: false, library: 'list' })).toBe(false)
  })
})

describe('Live keys readiness', () => {
  it('needs the notes ready with at least one note; never the demo (no audio → unavailable)', () => {
    const ready = (count: number) => ({ status: 'ready', index: { count } }) as unknown as NotesState
    expect(keysNotesReady(ready(3))).toBe(true)
    expect(keysNotesReady(ready(0))).toBe(false)
    expect(keysNotesReady({ status: 'unavailable' })).toBe(false)
    expect(keysNotesReady({ status: 'loading' })).toBe(false)
    expect(keysNotesReady({ status: 'idle' })).toBe(false)
  })
})

describe('Listen and YouTube readiness', () => {
  it('only at the start button: not while asking, failing, stopping or saving', () => {
    expect(listenReady('idle')).toBe(true)
    for (const phase of ['requesting', 'starting', 'live', 'paused', 'stopping', 'saving', 'done', 'error']) expect(listenReady(phase), phase).toBe(false)
  })

  it('YouTube also needs its player loaded', () => {
    expect(captureReady('idle', 'ready')).toBe(true)
    expect(captureReady('idle', 'loading')).toBe(false)
    expect(captureReady('idle', 'embed')).toBe(false)
    expect(captureReady('requesting', 'ready')).toBe(false)
  })
})
