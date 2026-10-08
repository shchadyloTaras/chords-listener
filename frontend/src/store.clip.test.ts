// A fragment track (docs/CLOUD.md → YouTube clips) opens with the playhead at the fragment's start, and seeking
// stays inside the fragment.
import { describe, expect, it, vi } from 'vitest'
import type { Track } from './types'

// settings are persisted: give the store a storage to write to
vi.hoisted(() =>
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
)

import { useApp } from './store'

const track = (patch: Partial<Track> = {}): Track => ({
  id: '0123456789ab',
  title: 'Song',
  duration: 102,
  source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' },
  createdAt: '2026-10-08T10:00:00Z',
  audioUrl: '/api/tracks/0123456789ab/audio',
  timeSignature: 4,
  beats: [],
  downbeats: [],
  chords: [],
  waveform: [],
  engine: 'test',
  ...patch,
})

describe('setTrack', () => {
  it('starts a fragment at its start, any other track at 0', () => {
    useApp.getState().setTrack(track({ clip: { start: 72, end: 102 }, startOffset: 72 }))
    expect(useApp.getState().currentTime).toBe(72)
    useApp.getState().setTrack(track())
    expect(useApp.getState().currentTime).toBe(0)
  })

  it('starts a recording linked to a video where the recording starts', () => {
    useApp.getState().setTrack(track({ startOffset: 40 }))
    expect(useApp.getState().currentTime).toBe(40)
  })
})

describe('seek', () => {
  it('stays inside a fragment', () => {
    const seek = vi.fn()
    useApp.getState().setTrack(track({ clip: { start: 72, end: 102 }, startOffset: 72 }))
    useApp.getState().registerController({ play() {}, pause() {}, seek, setRate() {}, setVolume() {}, getTime: () => 0 })
    // the player knows the audio's own end (offset + file length) a little past the fragment
    useApp.getState().setPlayback({ duration: 102.04 })
    useApp.getState().seek(0)
    expect(useApp.getState().currentTime).toBe(72)
    useApp.getState().seek(500)
    expect(useApp.getState().currentTime).toBe(102)
    useApp.getState().seek(80)
    expect(useApp.getState().currentTime).toBe(80)
    expect(seek.mock.calls.map(([t]) => t)).toEqual([72, 102, 80])
  })

  it('covers the whole of any other track', () => {
    useApp.getState().setTrack(track())
    useApp.getState().seek(-3)
    expect(useApp.getState().currentTime).toBe(0)
    useApp.getState().seek(500)
    expect(useApp.getState().currentTime).toBe(102)
  })
})
