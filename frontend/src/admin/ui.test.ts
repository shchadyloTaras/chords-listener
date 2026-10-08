// S2-9: the admin page is Ukrainian whatever the site language is; S2-10: shared classes live in ui.ts.
import { describe, expect, it } from 'vitest'
import { adminErrorMessage, AdminApiError } from '../lib/adminApi'
import { useApp } from '../store'

describe('admin language', () => {
  it('shows error texts in Ukrainian even when the site language is English', () => {
    useApp.setState({ lang: 'en' })
    try {
      expect(adminErrorMessage(new AdminApiError('x', 'query_too_short', 400))).toBe('Введіть щонайменше 3 символи')
    } finally {
      useApp.setState({ lang: 'uk' })
    }
  })
})
