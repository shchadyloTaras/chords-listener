import { describe, expect, it } from 'vitest'
import { YT_STATE } from '../player/sources/youtubeApi'
import {
  captureReducer,
  chooseStartOffset,
  initialCapture,
  playerEvent,
  sessionCommand,
  type CaptureEvent,
  type CaptureState,
} from './machine'

function run(events: CaptureEvent[], from: CaptureState = initialCapture): CaptureState {
  return events.reduce(captureReducer, from)
}

describe('capture state machine', () => {
  it('follows the video: waits for it to play, pauses and resumes with it, saves at the end', () => {
    let s = run([{ type: 'start' }])
    expect(s.phase).toBe('requesting')
    s = captureReducer(s, { type: 'granted', waitForMedia: true })
    expect(s.phase).toBe('starting')
    // buffering before the first frame keeps waiting
    expect(captureReducer(s, { type: 'paused' }).phase).toBe('starting')
    s = captureReducer(s, { type: 'playing' })
    expect(s.phase).toBe('live')
    s = captureReducer(s, { type: 'paused' })
    expect(s.phase).toBe('paused')
    s = captureReducer(s, { type: 'playing' })
    expect(s.phase).toBe('live')
    s = run([{ type: 'stop' }, { type: 'recorded', usable: true }], s)
    expect(s).toEqual({ phase: 'saving', error: null, hasRecording: true })
    expect(captureReducer(s, { type: 'saved' }).phase).toBe('done')
  })

  it('listens right away when nothing has to start playing (microphone)', () => {
    const s = run([{ type: 'start' }, { type: 'granted', waitForMedia: false }])
    expect(s.phase).toBe('live')
  })

  it('reports a refused capture and lets the user start again', () => {
    const s = run([{ type: 'start' }, { type: 'failed', error: 'no-audio' }])
    expect(s).toEqual({ phase: 'error', error: 'no-audio', hasRecording: false })
    expect(captureReducer(s, { type: 'start' }).phase).toBe('requesting')
  })

  it('keeps a recording whose save failed: retry, but no new capture over it', () => {
    let s = run([
      { type: 'start' },
      { type: 'granted', waitForMedia: false },
      { type: 'stop' },
      { type: 'recorded', usable: true },
      { type: 'saveFailed' },
    ])
    expect(s).toEqual({ phase: 'error', error: 'save', hasRecording: true })
    expect(captureReducer(s, { type: 'start' })).toBe(s)
    s = captureReducer(s, { type: 'retrySave' })
    expect(s.phase).toBe('saving')
    expect(captureReducer(s, { type: 'reset' })).toEqual(initialCapture)
  })

  it('rejects a recording that is too short', () => {
    const s = run([{ type: 'start' }, { type: 'granted', waitForMedia: false }, { type: 'stop' }, { type: 'recorded', usable: false }])
    expect(s).toEqual({ phase: 'error', error: 'too-short', hasRecording: false })
  })

  it('ignores events that do not fit the phase', () => {
    expect(captureReducer(initialCapture, { type: 'playing' })).toBe(initialCapture)
    expect(captureReducer(initialCapture, { type: 'stop' })).toBe(initialCapture)
    expect(captureReducer(initialCapture, { type: 'recorded', usable: true })).toBe(initialCapture)
    const saving = run([{ type: 'start' }, { type: 'granted', waitForMedia: false }, { type: 'stop' }, { type: 'recorded', usable: true }])
    expect(captureReducer(saving, { type: 'stop' })).toBe(saving)
    expect(captureReducer(saving, { type: 'start' })).toBe(saving)
  })

  it('tells the live session what to do on each step', () => {
    expect(sessionCommand('starting', 'live')).toBe('resume')
    expect(sessionCommand('paused', 'live')).toBe('resume')
    expect(sessionCommand('live', 'paused')).toBe('pause')
    expect(sessionCommand('live', 'stopping')).toBe('stop')
    expect(sessionCommand('paused', 'stopping')).toBe('stop')
    expect(sessionCommand('requesting', 'live')).toBeNull()
    expect(sessionCommand('live', 'live')).toBeNull()
    expect(sessionCommand('stopping', 'saving')).toBeNull()
  })

  it('maps YouTube player states', () => {
    expect(playerEvent(YT_STATE.PLAYING)).toEqual({ type: 'playing' })
    expect(playerEvent(YT_STATE.PAUSED)).toEqual({ type: 'paused' })
    expect(playerEvent(YT_STATE.BUFFERING)).toEqual({ type: 'paused' })
    expect(playerEvent(YT_STATE.ENDED)).toEqual({ type: 'stop' })
    expect(playerEvent(YT_STATE.CUED)).toBeNull()
    expect(playerEvent(YT_STATE.UNSTARTED)).toBeNull()
  })
})

describe('start offset', () => {
  it('starts from the beginning unless the user moved the video', () => {
    expect(chooseStartOffset(0, 200)).toBe(0)
    expect(chooseStartOffset(0.6, 200)).toBe(0)
    expect(chooseStartOffset(NaN, 200)).toBe(0)
    expect(chooseStartOffset(42.37, 200)).toBe(42.4)
    expect(chooseStartOffset(42.37, 0)).toBe(42.4)
  })

  it('starts over when the video is at its end', () => {
    expect(chooseStartOffset(199, 200)).toBe(0)
    expect(chooseStartOffset(200, 200)).toBe(0)
  })
})
