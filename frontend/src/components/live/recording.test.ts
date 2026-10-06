import { describe, expect, it } from 'vitest'
import { recordingCaption } from './recording'

describe('recordingCaption (the microphone recording view)', () => {
  it('says it records while the sound is fine', () => {
    expect(recordingCaption({ state: 'running' }, false)).toEqual({ key: 'live.rec.hint', tone: 'muted' })
  })

  it('warns when it has been quiet for a while', () => {
    expect(recordingCaption({ state: 'running' }, true)).toEqual({ key: 'live.quiet', tone: 'warn' })
  })

  it('explains a pause and a closed source, the latter first', () => {
    expect(recordingCaption({ state: 'paused' }, false)).toEqual({ key: 'live.paused.hint', tone: 'muted' })
    expect(recordingCaption({ state: 'running', ended: true }, true)).toEqual({ key: 'live.ended.hint', tone: 'warn' })
    expect(recordingCaption({ state: 'paused', ended: true }, false)).toEqual({ key: 'live.ended.hint', tone: 'warn' })
  })

  it('has nothing to say before the session exists', () => {
    expect(recordingCaption({ state: 'idle' }, false)).toBeNull()
  })

  it('has nothing to say once stopped (the saving line takes over)', () => {
    expect(recordingCaption({ state: 'stopped', ended: true }, false)).toBeNull()
    expect(recordingCaption({ state: 'stopped' }, false)).toBeNull()
  })
})
