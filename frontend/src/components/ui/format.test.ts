import { describe, expect, it } from 'vitest'
import { formatRange } from './format'

describe('formatRange', () => {
  it('a fragment of a video', () => {
    expect(formatRange(72, 102)).toBe('1:12–1:42')
    expect(formatRange(72, 102, ' – ')).toBe('1:12 – 1:42')
    expect(formatRange(3590, 3620)).toBe('0:59:50–1:00:20')
  })
})
