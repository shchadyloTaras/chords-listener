import { describe, expect, it } from 'vitest'
import { CaptureError } from '../../lib/live'
import { failureOf } from './useCapture'

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
