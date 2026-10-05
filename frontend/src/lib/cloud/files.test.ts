// track.json, notes.json and vocals.json of the signed-in user's library, read straight from Firebase Storage
// (the SDK is mocked: `sdk.objects` holds what each object path answers), and the download-token URLs built from
// track.json's `media`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  /** object path → its bytes, the error reading it throws, or 'hang' (no answer, ever) */
  objects: new Map<string, ArrayBuffer | Error | 'hang'>(),
  reads: [] as string[],
  /** the FirebaseStorage instance */
  storage: { maxOperationRetryTime: 120_000 },
}))

vi.mock('./storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage')>()),
  loadStorage: async () => ({
    storage: sdk.storage,
    sdk: {
      ref: (_storage: unknown, path: string) => ({ fullPath: path }),
      getBytes: (ref: { fullPath: string }) => {
        sdk.reads.push(ref.fullPath)
        const answer = sdk.objects.get(ref.fullPath)
        if (answer === 'hang') return new Promise<ArrayBuffer>(() => undefined)
        if (answer instanceof Error) return Promise.reject(answer)
        if (!answer) return Promise.reject(storageError('storage/object-not-found'))
        return Promise.resolve(answer)
      },
    },
  }),
}))

import { ApiError } from '../api'
import { mediaUrl, readJsonFile, readTrackFile, STORAGE_READ_TIMEOUT_MS, STORAGE_RETRY_MS, trackFromFile, type TrackFile } from './files'

const BUCKET = 'build-chords-listener.firebasestorage.app'

function storageError(code: string): Error {
  return Object.assign(new Error(`Firebase Storage: ${code}`), { code })
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer

function trackJson(uid: string, patch: Record<string, unknown> = {}) {
  return {
    id: 'abc123',
    title: 'Song',
    duration: 10,
    source: { type: 'file', filename: 'song.mp3' },
    createdAt: '2026-10-05T10:00:00Z',
    vocals: true,
    stems: ['vocals', 'instruments'],
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
    version: 4,
    media: {
      audio: { path: `users/${uid}/tracks/abc123/audio.mp3`, token: 'tok-a' },
      stems: {
        vocals: { path: `users/${uid}/tracks/abc123/stems/vocals.mp3`, token: 'tok-v' },
        instruments: { path: `users/${uid}/tracks/abc123/stems/instruments.mp3`, token: 'tok-i' },
      },
    },
    ...patch,
  }
}

const tokenUrl = (path: string, token: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`

beforeEach(() => {
  sdk.objects.clear()
  sdk.reads = []
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mediaUrl', () => {
  it('is the download-token URL of the object in the project’s bucket, its path encoded', () => {
    expect(mediaUrl({ path: 'users/alice/tracks/abc123/audio.mp3', token: 'tok-a' })).toBe(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/users%2Falice%2Ftracks%2Fabc123%2Faudio.mp3?alt=media&token=tok-a`,
    )
  })
})

describe('trackFromFile', () => {
  it('gives the audio and each stem its token URL and keeps the version', () => {
    const track = trackFromFile(trackJson('alice') as TrackFile)
    expect(track.audioUrl).toBe(tokenUrl('users/alice/tracks/abc123/audio.mp3', 'tok-a'))
    expect(track.stemUrls).toEqual({
      vocals: tokenUrl('users/alice/tracks/abc123/stems/vocals.mp3', 'tok-v'),
      instruments: tokenUrl('users/alice/tracks/abc123/stems/instruments.mp3', 'tok-i'),
    })
    expect(track).toMatchObject({ id: 'abc123', title: 'Song', version: 4, engine: 'madmom' })
    expect(track).not.toHaveProperty('media')
  })
})

describe('readTrackFile', () => {
  it('reads users/{uid}/tracks/{id}/track.json', async () => {
    sdk.objects.set('users/alice/tracks/abc123/track.json', bytes(trackJson('alice')))
    const file = await readTrackFile('alice', 'abc123')
    expect(sdk.reads).toEqual(['users/alice/tracks/abc123/track.json'])
    expect(file).toMatchObject({ id: 'abc123', version: 4, media: { audio: { path: 'users/alice/tracks/abc123/audio.mp3', token: 'tok-a' } } })
  })

  it('no such object (not published yet): null', async () => {
    expect(await readTrackFile('bob', 'abc123')).toBeNull()
    expect(sdk.reads).toEqual(['users/bob/tracks/abc123/track.json'])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a file without the audio in `media` (its object was missing when published) is not usable: null', async () => {
    const { media } = trackJson('carol')
    sdk.objects.set('users/carol/tracks/abc123/track.json', bytes(trackJson('carol', { media: { stems: media.stems } })))
    expect(await readTrackFile('carol', 'abc123')).toBeNull()
    sdk.objects.set('users/carol/tracks/abc123/track.json', bytes(trackJson('carol', { version: undefined })))
    expect(await readTrackFile('carol', 'abc123')).toBeNull()
  })

  it('not JSON: null', async () => {
    sdk.objects.set('users/dave/tracks/abc123/track.json', new TextEncoder().encode('{"id":').buffer as ArrayBuffer)
    expect(await readTrackFile('dave', 'abc123')).toBeNull()
  })

  it('an id that is not one path segment reads nothing', async () => {
    expect(await readTrackFile('erin', '../quota')).toBeNull()
    expect(sdk.reads).toEqual([])
  })

  it('refused by the rules: ApiError unauthorized', async () => {
    sdk.objects.set('users/frank/tracks/abc123/track.json', storageError('storage/unauthorized'))
    const err = await readTrackFile('frank', 'abc123').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'unauthorized' })
  })

  it('any other failure (CORS, network): ApiError network', async () => {
    sdk.objects.set('users/grace/tracks/abc123/track.json', storageError('storage/retry-limit-exceeded'))
    await expect(readTrackFile('grace', 'abc123')).rejects.toMatchObject({ name: 'ApiError', code: 'network' })
  })

  it('a failed read is not tried again this session for that file; other files and another account are', async () => {
    sdk.objects.set('users/heidi/tracks/abc123/track.json', storageError('storage/unauthorized'))
    sdk.objects.set('users/heidi/tracks/abc123/notes.json', bytes({ version: 1, notes: [] }))
    await expect(readTrackFile('heidi', 'abc123')).rejects.toBeInstanceOf(ApiError)
    expect(console.warn).toHaveBeenCalledTimes(1)
    // the rules are fixed meanwhile: still the API's for this session (no retry storm)
    sdk.objects.set('users/heidi/tracks/abc123/track.json', bytes(trackJson('heidi')))
    await expect(readTrackFile('heidi', 'other1')).rejects.toBeInstanceOf(ApiError)
    expect(sdk.reads).toEqual(['users/heidi/tracks/abc123/track.json'])
    expect(await readJsonFile('heidi', 'abc123', 'notes.json')).toEqual({ version: 1, notes: [] })
    // another account starts afresh, and so does the first one after it
    expect(await readTrackFile('ivan', 'abc123')).toBeNull()
    expect(await readTrackFile('heidi', 'abc123')).toMatchObject({ version: 4 })
  })
})

describe('a read is bounded', () => {
  it('the SDK retries a read that fails at the network level (no CORS, blocked, offline) for seconds, not 2 minutes', async () => {
    sdk.storage.maxOperationRetryTime = 120_000
    await readTrackFile('lena', 'abc123')
    expect(sdk.storage.maxOperationRetryTime).toBe(STORAGE_RETRY_MS)
    expect(STORAGE_RETRY_MS).toBeLessThanOrEqual(5000)
  })

  it('no answer in time counts as a failure: ApiError network, and the file is not read again this session', async () => {
    vi.useFakeTimers()
    sdk.objects.set('users/mike/tracks/abc123/track.json', 'hang')
    const read = readTrackFile('mike', 'abc123')
    const failed = expect(read).rejects.toMatchObject({ name: 'ApiError', code: 'network' })
    await vi.advanceTimersByTimeAsync(STORAGE_READ_TIMEOUT_MS - 1)
    expect(console.warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(console.warn).toHaveBeenCalledTimes(1)
    await expect(readTrackFile('mike', 'other1')).rejects.toBeInstanceOf(ApiError)
    expect(sdk.reads).toEqual(['users/mike/tracks/abc123/track.json'])
    expect(STORAGE_READ_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })
})

describe('readJsonFile', () => {
  it('reads notes.json and vocals.json; not computed yet (no object): null', async () => {
    sdk.objects.set('users/judy/tracks/abc123/notes.json', bytes({ version: 1, engine: 'basic-pitch', notes: [[1, 2, 60, 0.8]] }))
    expect(await readJsonFile('judy', 'abc123', 'notes.json')).toEqual({ version: 1, engine: 'basic-pitch', notes: [[1, 2, 60, 0.8]] })
    expect(await readJsonFile('judy', 'abc123', 'vocals.json')).toBeNull()
    expect(sdk.reads).toEqual(['users/judy/tracks/abc123/notes.json', 'users/judy/tracks/abc123/vocals.json'])
  })

  it('a failure is an ApiError', async () => {
    sdk.objects.set('users/kim/tracks/abc123/vocals.json', storageError('storage/unknown'))
    await expect(readJsonFile('kim', 'abc123', 'vocals.json')).rejects.toMatchObject({ name: 'ApiError', code: 'network' })
  })
})
