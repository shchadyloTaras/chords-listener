import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackNotes } from '../../types'

const api = vi.hoisted(() => ({
  getTrackNotes: vi.fn<(id: string, signal?: AbortSignal) => Promise<TrackNotes | null>>(),
  saveTrackNotes: vi.fn<(id: string, notes: TrackNotes) => Promise<void>>(),
  fetchTrackAudio: vi.fn<(track: { id: string }, signal?: AbortSignal) => Promise<Blob>>(),
}))
const runner = vi.hoisted(() => ({ createTranscriber: vi.fn() }))
const audio = vi.hoisted(() => ({ decodeForModel: vi.fn() }))
const stems = vi.hoisted(() => ({
  getStemNotes: vi.fn<(key: string) => Promise<TrackNotes | null>>(),
  putStemNotes: vi.fn<(key: string, notes: TrackNotes) => Promise<void>>(),
}))

vi.mock('../api', async () => {
  const real = await vi.importActual<typeof import('../api')>('../api')
  return { ...real, ...api }
})
vi.mock('./runner', async () => {
  const real = await vi.importActual<typeof import('./runner')>('./runner')
  return { ...real, createTranscriber: runner.createTranscriber }
})
vi.mock('./audio', () => audio)
vi.mock('./stemCache', () => stems)

import { ApiError } from '../api'
import { TranscriberError } from './runner'
import { getNotesState, notesKey, requestNotes, releaseNotes, resetNotesService, retainNotes, useNotesStore, type NotesState } from './service'

const SAVED: TrackNotes = { version: 1, engine: 'saved', notes: [[0.5, 1, 60, 0.7]] }
const track = (id = 'aaaaaaaaaaaa', audioUrl = '/api/tracks/aaaaaaaaaaaa/audio') => ({ id, audioUrl, duration: 30 })

const state = (id: string): NotesState => useNotesStore.getState().tracks[id] ?? { status: 'idle' }

async function settle(id: string, until: NotesState['status'][] = ['ready', 'error', 'unavailable']): Promise<NotesState> {
  for (let i = 0; i < 200; i++) {
    const s = state(id)
    if (until.includes(s.status)) return s
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error(`notes of ${id} did not settle: ${state(id).status}`)
}

/** A transcriber whose run() resolves with two notes (or waits for `gate`). */
function fakeTranscriber(opts: { gate?: Promise<void>; signalSeen?: (s: AbortSignal) => void } = {}) {
  return vi.fn(async (_url: string, signal: AbortSignal) => {
    opts.signalSeen?.(signal)
    return {
      backend: 'webgl',
      thread: 'worker',
      dispose: vi.fn(),
      run: vi.fn(async (_samples: Float32Array, progress?: (f: number, n: number) => void) => {
        progress?.(0.5, 1)
        if (opts.gate) await opts.gate
        if (signal.aborted) throw signal.reason
        return {
          notes: [
            { midi: 64, start: 1, end: 1.5, velocity: 0.9 },
            { midi: 60, start: 0.5, end: 1.25, velocity: 0.5 },
          ],
          stats: { backend: 'webgl', thread: 'worker', modelMs: 10, decodeMs: 1, windows: 1 },
        }
      }),
    }
  })
}

beforeEach(() => {
  resetNotesService()
  vi.stubGlobal('location', new URL('http://localhost:8765/'))
  api.getTrackNotes.mockReset().mockResolvedValue(null)
  api.saveTrackNotes.mockReset().mockResolvedValue(undefined)
  api.fetchTrackAudio.mockReset().mockResolvedValue(new Blob(['mp3']))
  audio.decodeForModel.mockReset().mockResolvedValue({ samples: new Float32Array(22050), duration: 1 })
  runner.createTranscriber.mockReset().mockImplementation(fakeTranscriber())
  stems.getStemNotes.mockReset().mockResolvedValue(null)
  stems.putStemNotes.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  resetNotesService()
  vi.unstubAllGlobals()
})

describe('notes service', () => {
  it('uses saved notes without transcribing', async () => {
    api.getTrackNotes.mockResolvedValue(SAVED)
    requestNotes(track())
    expect(state('aaaaaaaaaaaa').status).toBe('loading')
    const s = await settle('aaaaaaaaaaaa')
    expect(s).toMatchObject({ status: 'ready', saved: true, engine: 'saved' })
    if (s.status === 'ready') expect(s.index.count).toBe(1)
    expect(runner.createTranscriber).not.toHaveBeenCalled()
  })

  it('transcribes once, saves, and serves the next request from memory', async () => {
    requestNotes(track())
    const s = await settle('aaaaaaaaaaaa')
    expect(s.status).toBe('ready')
    if (s.status === 'ready') {
      expect(s.saved).toBe(true)
      expect(s.index.count).toBe(2)
      expect([...s.index.notes.midi]).toEqual([60, 64]) // sorted by start
    }
    expect(api.saveTrackNotes).toHaveBeenCalledTimes(1)
    const [id, saved] = api.saveTrackNotes.mock.calls[0]
    expect(id).toBe('aaaaaaaaaaaa')
    expect(saved).toMatchObject({ version: 1, notes: [[0.5, 1.25, 60, 0.5], [1, 1.5, 64, 0.9]] })
    expect(saved.engine).toMatch(/^basic-pitch/)
    requestNotes(track())
    expect(state('aaaaaaaaaaaa').status).toBe('ready')
    expect(runner.createTranscriber).toHaveBeenCalledTimes(1)
    expect(api.getTrackNotes).toHaveBeenCalledTimes(1)
  })

  it('"recognize again" transcribes and saves again', async () => {
    api.getTrackNotes.mockResolvedValue(SAVED)
    requestNotes(track())
    await settle('aaaaaaaaaaaa')
    requestNotes(track(), { force: true })
    expect(state('aaaaaaaaaaaa').status).toBe('computing')
    const s = await settle('aaaaaaaaaaaa')
    expect(s).toMatchObject({ status: 'ready', saved: true })
    expect(runner.createTranscriber).toHaveBeenCalledTimes(1)
    expect(api.saveTrackNotes).toHaveBeenCalledTimes(1)
  })

  it('reports progress while computing', async () => {
    let open: () => void = () => undefined
    runner.createTranscriber.mockImplementation(fakeTranscriber({ gate: new Promise<void>((r) => (open = r)) }))
    requestNotes(track())
    const s = await settle('aaaaaaaaaaaa', ['computing'])
    expect(s.status).toBe('computing')
    for (let i = 0; i < 50 && !(state('aaaaaaaaaaaa').status === 'computing' && (state('aaaaaaaaaaaa') as { found: number }).found > 0); i++)
      await new Promise((r) => setTimeout(r, 1))
    expect(state('aaaaaaaaaaaa')).toMatchObject({ status: 'computing', stage: 'model', backend: 'webgl', found: 1 })
    const p = (state('aaaaaaaaaaaa') as { progress: number }).progress
    expect(p).toBeGreaterThan(0.5)
    expect(p).toBeLessThan(0.6)
    open()
    expect((await settle('aaaaaaaaaaaa')).status).toBe('ready')
  })

  it('has nothing to do for a track without audio (the demo)', () => {
    requestNotes(track('demo', ''))
    expect(state('demo').status).toBe('unavailable')
    expect(api.getTrackNotes).not.toHaveBeenCalled()
  })

  it('stops a transcription when another track is requested', async () => {
    let first: AbortSignal | null = null
    let open: () => void = () => undefined
    runner.createTranscriber.mockImplementationOnce(
      fakeTranscriber({ gate: new Promise<void>((r) => (open = r)), signalSeen: (s) => (first = s) }),
    )
    requestNotes(track('aaaaaaaaaaaa'))
    await settle('aaaaaaaaaaaa', ['computing'])
    for (let i = 0; i < 50 && !first; i++) await new Promise((r) => setTimeout(r, 1))
    requestNotes(track('bbbbbbbbbbbb', '/api/tracks/bbbbbbbbbbbb/audio'))
    expect(first!.aborted).toBe(true)
    expect(state('aaaaaaaaaaaa').status).toBe('idle')
    open()
    expect((await settle('bbbbbbbbbbbb')).status).toBe('ready')
    expect(state('aaaaaaaaaaaa').status).toBe('idle')
    expect(api.saveTrackNotes.mock.calls.map((c) => c[0])).toEqual(['bbbbbbbbbbbb'])
  })

  it('keeps running while a view holds the track and stops after the last one leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let signal: AbortSignal | null = null
      runner.createTranscriber.mockImplementation(fakeTranscriber({ gate: new Promise<void>(() => undefined), signalSeen: (s) => (signal = s) }))
      retainNotes('aaaaaaaaaaaa')
      requestNotes(track())
      await vi.waitFor(() => expect(signal).not.toBeNull())
      retainNotes('aaaaaaaaaaaa') // a second view (e.g. a remount)
      releaseNotes('aaaaaaaaaaaa')
      vi.advanceTimersByTime(5000)
      expect(signal!.aborted).toBe(false)
      releaseNotes('aaaaaaaaaaaa')
      vi.advanceTimersByTime(1000)
      expect(signal!.aborted).toBe(false) // grace period
      vi.advanceTimersByTime(2000)
      expect(signal!.aborted).toBe(true)
      expect(state('aaaaaaaaaaaa').status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps failures to error codes and can retry', async () => {
    api.fetchTrackAudio.mockRejectedValueOnce(new ApiError('down', 'network'))
    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'error', code: 'server' })

    api.fetchTrackAudio.mockRejectedValueOnce(new ApiError('gone', 'not_found', 404))
    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'error', code: 'audio' })

    audio.decodeForModel.mockRejectedValueOnce(new Error('EncodingError'))
    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'error', code: 'decode' })

    runner.createTranscriber.mockRejectedValueOnce(new TranscriberError('model', '404 model.json'))
    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'error', code: 'model' })

    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'ready' })
  })

  it('lets the worker go when the audio cannot be read', async () => {
    const dispose = vi.fn()
    runner.createTranscriber.mockResolvedValueOnce({ backend: 'webgl', thread: 'worker', dispose, run: vi.fn() })
    api.fetchTrackAudio.mockRejectedValueOnce(new ApiError('down', 'network'))
    requestNotes(track())
    await settle('aaaaaaaaaaaa')
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
  })

  it('keeps the notes for the session when saving fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    api.saveTrackNotes.mockRejectedValueOnce(new ApiError('Unknown API endpoint', 'not_found', 404))
    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'ready', saved: false })
    warn.mockRestore()
  })

  it('recomputes saved notes that are invalid', async () => {
    api.getTrackNotes.mockResolvedValue({ version: 1, engine: 'x', notes: [[5, 1, 60, 0.5]] })
    requestNotes(track())
    expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'ready', saved: true })
    expect(runner.createTranscriber).toHaveBeenCalledTimes(1)
  })

  describe('sources', () => {
    const stemTrack = (loadAudio = vi.fn(async () => new Blob(['stem']))) => ({ ...track(), notesSource: 'instruments' as const, loadAudio })

    it('transcribes the instruments stem separately from the mix and keeps it on this device', async () => {
      const loadAudio = vi.fn(async () => new Blob(['stem']))
      requestNotes(stemTrack(loadAudio))
      const key = notesKey('aaaaaaaaaaaa', 'instruments')
      expect(key).not.toBe('aaaaaaaaaaaa')
      const s = await settle(key)
      expect(s).toMatchObject({ status: 'ready', source: 'instruments', saved: true })
      if (s.status === 'ready') expect(s.engine).toMatch(/instruments stem/)
      expect(loadAudio).toHaveBeenCalledTimes(1)
      expect(api.fetchTrackAudio).not.toHaveBeenCalled()
      expect(api.getTrackNotes).not.toHaveBeenCalled()
      expect(api.saveTrackNotes).not.toHaveBeenCalled()
      expect(stems.putStemNotes).toHaveBeenCalledTimes(1)
      expect(stems.putStemNotes.mock.calls[0][0]).toMatch(/\|aaaaaaaaaaaa\|instruments$/)
      // the mix is untouched
      expect(getNotesState('aaaaaaaaaaaa').status).toBe('idle')
    })

    it('reads saved stem notes without transcribing', async () => {
      stems.getStemNotes.mockResolvedValue(SAVED)
      requestNotes(stemTrack())
      const s = await settle(notesKey('aaaaaaaaaaaa', 'instruments'))
      expect(s).toMatchObject({ status: 'ready', saved: true, engine: 'saved', source: 'instruments' })
      expect(runner.createTranscriber).not.toHaveBeenCalled()
    })

    it('a stem source without audio is unavailable', () => {
      requestNotes({ ...track(), notesSource: 'instruments' })
      expect(getNotesState('aaaaaaaaaaaa', 'instruments').status).toBe('unavailable')
    })

    it('the mix still reports its source', async () => {
      requestNotes(track())
      expect(await settle('aaaaaaaaaaaa')).toMatchObject({ status: 'ready', source: 'mix' })
    })
  })
})
