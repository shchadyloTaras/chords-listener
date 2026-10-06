import { describe, expect, it } from 'vitest'
import { CaptureError } from '../../lib/live'
import { failureOf, liveOptionsFor } from './useCapture'

describe('failureOf', () => {
  it('keeps a CaptureError code and the browser message it carries', () => {
    expect(failureOf(new CaptureError('blocked', 'NotAllowedError: Permission denied by system'))).toEqual({
      code: 'blocked',
      detail: 'NotAllowedError: Permission denied by system',
    })
  })

  it('has no detail when the CaptureError carries only its code', () => {
    expect(failureOf(new CaptureError('no-audio'))).toEqual({ code: 'no-audio', detail: null })
  })

  it('treats anything else as a failure, keeping its message', () => {
    expect(failureOf(new Error('boom'))).toEqual({ code: 'failed', detail: 'boom' })
    expect(failureOf('weird')).toEqual({ code: 'failed', detail: 'weird' })
    expect(failureOf(null)).toEqual({ code: 'failed', detail: 'null' })
  })
})

describe('liveOptionsFor', () => {
  it('records the microphone without live chords (the full analysis of the recording gives them)', () => {
    expect(liveOptionsFor('mic')).toEqual({ record: true, analyze: false })
  })

  it('shows live chords for a tab', () => {
    expect(liveOptionsFor('tab')).toEqual({ record: true, analyze: true })
  })
})
