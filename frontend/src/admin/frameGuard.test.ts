// S2-8: a <meta> CSP ignores frame-ancestors, so the page itself leaves a frame.
import { describe, expect, it } from 'vitest'
import { breakOutOfFrame } from './frameGuard'

describe('breakOutOfFrame', () => {
  it('does nothing and says the page may render when it is the top window', () => {
    const win: { top: unknown; self: unknown; location: { href: string } } = { top: null, self: null, location: { href: 'https://x/admin.html' } }
    win.top = win
    win.self = win
    expect(breakOutOfFrame(win as never)).toBe(true)
  })

  it('navigates the top window to this page and says not to render when framed', () => {
    const top = { location: { href: 'https://evil/' } }
    const win = { top, self: {}, location: { href: 'https://x/admin.html#/users' } }
    expect(breakOutOfFrame(win as never)).toBe(false)
    expect(top.location.href).toBe('https://x/admin.html#/users')
  })

  it('renders nothing when the top window cannot be touched (cross-origin)', () => {
    const top = {
      get location(): never {
        throw new DOMException('blocked', 'SecurityError')
      },
    }
    const win = { top, self: {}, location: { href: 'https://x/admin.html' } }
    expect(breakOutOfFrame(win as never)).toBe(false)
  })
})
