// How the player gets a cloud track's audio: the copy kept on this device (no request), else the signed URL,
// downloading the file once in the background for next time.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types'

const mocks = vi.hoisted(() => ({
  cachedAudio: vi.fn<(uid: string, id: string) => Promise<Blob | null>>(),
  forgetTrack: vi.fn<(uid: string, id: string, parts?: readonly string[]) => Promise<void>>(),
  fetchTrackAudio: vi.fn<(track: Pick<Track, 'id' | 'audioUrl'>) => Promise<Blob>>(),
}))

vi.mock('../../lib/cloud/cache', () => ({ cachedAudio: mocks.cachedAudio, forgetTrack: mocks.forgetTrack }))
vi.mock('../../lib/api', () => ({ fetchTrackAudio: mocks.fetchTrackAudio }))

import { cloudPlayback } from './cloudAudio'

const SIGNED = 'https://cloud.example/api/tracks/abc/audio?u=uid42&exp=1&sig=x'
const track: Track = {
  id: 'abc',
  title: 'Song',
  duration: 10,
  source: { type: 'file' },
  createdAt: '2026-10-05T00:00:00Z',
  audioUrl: SIGNED,
  timeSignature: 4,
  beats: [],
  downbeats: [],
  chords: [],
  waveform: [],
  engine: 'madmom',
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.forgetTrack.mockResolvedValue(undefined)
})

describe('cloudPlayback', () => {
  it('plays the copy on this device; a copy that does not play is dropped for the signed URL', async () => {
    mocks.cachedAudio.mockResolvedValue(new Blob(['mp3'], { type: 'audio/mpeg' }))
    const p = await cloudPlayback('uid42', track)
    expect(p.track.audioUrl.startsWith('blob:')).toBe(true)
    expect(p.media.onReady).toBeUndefined()
    expect(await p.media.recover?.()).toBe(SIGNED)
    expect(mocks.forgetTrack).toHaveBeenCalledWith('uid42', 'abc', ['audio'])
    expect(mocks.fetchTrackAudio).not.toHaveBeenCalled()
    p.release?.()
  })

  it('no copy yet: streams the signed URL and downloads the file once it can play through', async () => {
    mocks.cachedAudio.mockResolvedValue(null)
    mocks.fetchTrackAudio.mockResolvedValue(new Blob(['mp3']))
    const p = await cloudPlayback('uid42', track)
    expect(p.track.audioUrl).toBe(SIGNED)
    expect(p.release).toBeUndefined()
    expect(mocks.fetchTrackAudio).not.toHaveBeenCalled()
    p.media.onReady?.()
    expect(mocks.fetchTrackAudio).toHaveBeenCalledWith(track)
    // the signed URL does not play (ran out): the whole file, through the URL refresh in fetchTrackAudio
    const url = await p.media.recover?.()
    expect(url?.startsWith('blob:')).toBe(true)
    if (url) URL.revokeObjectURL(url)
  })
})
