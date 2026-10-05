import { describe, expect, it } from 'vitest'
import { toastDuration } from './store'

describe('toastDuration', () => {
  it('keeps short info toasts short', () => expect(toastDuration('Готово', false, 'info')).toBe(2400))
  it('gives errors time to read', () => expect(toastDuration('x'.repeat(120), false, 'error')).toBeGreaterThanOrEqual(6000))
  it('never cuts an error short, however brief', () => expect(toastDuration('Oops', false, 'error')).toBeGreaterThanOrEqual(6000))
  it('lets a toast with an action stay at least 6 s', () => expect(toastDuration('Готово', true, 'info')).toBe(6000))
  it('gives a long message with a button time to be read', () => expect(toastDuration('x'.repeat(100), true, 'info')).toBe(7000))
  it('keeps a plain success note brief', () => expect(toastDuration('Скопійовано', false, 'success')).toBe(2400))
  it('caps at 12 s', () => expect(toastDuration('x'.repeat(1000), true, 'error')).toBe(12000))
})
