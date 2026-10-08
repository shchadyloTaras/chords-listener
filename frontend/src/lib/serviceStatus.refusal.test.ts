// AC-18 / AC-26 / AC-28: which cloud refusals come from the administrator (restriction, pause, switches) — one list
// for every place that words them or hides a retry.
import { describe, expect, it } from 'vitest'
import { isAdminRefusal } from './serviceStatus'

describe('isAdminRefusal', () => {
  it.each(['cloud_restricted', 'analyses_paused', 'youtube_disabled', 'vocals_disabled'])('%s is the administrator\'s', (code) => {
    expect(isAdminRefusal(code)).toBe(true)
  })
  it.each(['quota_exceeded', 'unauthorized', 'network', '', undefined, null])('%s is not', (code) => {
    expect(isAdminRefusal(code)).toBe(false)
  })
})
