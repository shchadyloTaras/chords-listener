// A fragment track (docs/CLOUD.md → YouTube clips) opens with the playhead at the fragment's start.
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
})
