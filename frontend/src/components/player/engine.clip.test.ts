// @vitest-environment jsdom
// A fragment track stopped at its end by the engine (docs/CLOUD.md → YouTube clips): the next play starts it again,
// even when the YouTube player rests a little before `clip.end` (its time is extrapolated while playing).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { PlaybackEngine } from './engine'
import type { PlaybackSource, SourceEvents } from './sources/types'

/** Stands in for the YouTube overlay: a paused player reports `restAt` (a bit before where it was stopped). */
class FakeSource implements PlaybackSource {
  readonly kind = 'youtube' as const
  time = 0
  restAt = 0
  playing = false
  seeks: number[] = []
  /** How often the engine read the time before it started the player. */
  readsBeforePlay = -1
  getTime = vi.fn(() => this.time)
  private events: SourceEvents
  constructor(events: SourceEvents) {
    this.events = events
  }
  play() {
    this.readsBeforePlay = this.getTime.mock.calls.length
    this.playing = true
    this.events.onPlay()
  }
  pause() {
    this.playing = false
  }
  /** The player's state-change event, which comes after pause() returned. */
  settle() {
    this.time = this.restAt
    this.events.onPause()
  }
  seek(time: number) {
    this.time = time
    this.seeks.push(time)
  }
  setRate() {}
  setVolume() {}
  isPlaying() {
    return this.playing
  }
  getDuration() {
    return 0
  }
  destroy() {}
}

const track = (patch: Partial<Track> = {}): Track => ({
  id: '0123456789ab',
  title: 'Song',
  duration: 122,
  source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' },
  createdAt: '2026-10-08T10:00:00Z',
  audioUrl: '', // no audio: the base source is the silent clock
  timeSignature: 4,
  beats: [],
  downbeats: [],
  chords: [],
  waveform: [],
  engine: 'test',
  clip: { start: 92, end: 122 },
  ...patch,
})

let engine: PlaybackEngine | null = null

/** An engine with the fake player attached, positioned at the track's start. */
function setup(t: Track) {
  useApp.getState().setTrack(t)
  engine = new PlaybackEngine(t)
  engine.controller.seek(t.clip?.start ?? 0)
  const fake = engine.create((events) => new FakeSource(events))
  engine.attachOverlay(fake)
  fake.getTime.mockClear()
  fake.seeks.length = 0
  return { controller: engine.controller, fake }
}

/** Plays the fragment up to its end: the player is past `clip.end` when the engine looks, and rests at `restAt`. */
function playToEnd(fake: FakeSource, controller: PlaybackEngine['controller'], restAt: number) {
  controller.play()
  fake.restAt = restAt
  fake.time = 122.1
  vi.advanceTimersByTime(50)
  fake.settle()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  engine?.destroy()
  engine = null
  vi.useRealTimers()
})

describe('play after the fragment was stopped at its end', () => {
  it('shows the end and restarts at the start, however far before the end the player rests', () => {
    const { controller, fake } = setup(track())
    playToEnd(fake, controller, 121.6) // 0.4 s before the end: outside the 0.25 s slack
    expect(useApp.getState().isPlaying).toBe(false)
    expect(useApp.getState().currentTime).toBe(122)
    expect(fake.getTime()).toBe(121.6)

    controller.play()
    expect(fake.seeks.at(-1)).toBe(92)
    expect(useApp.getState().currentTime).toBe(92)
    expect(fake.playing).toBe(true)
  })

  it('a seek after the stop cancels the restart', () => {
    const { controller, fake } = setup(track())
    playToEnd(fake, controller, 121.6)

    controller.seek(100)
    controller.play()
    expect(fake.seeks).toEqual([100])
  })

  it('does not ask a track without a fragment for its time when play starts', () => {
    const { controller, fake } = setup(track({ clip: null }))
    controller.play()
    expect(fake.readsBeforePlay).toBe(0)
    expect(fake.seeks).toEqual([])
  })
})
