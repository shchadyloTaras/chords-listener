// Hash routes of the admin page (admin.html): the six screens named in the nav, a user card, nothing else.
import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, adminPaths, parseAdminHash } from './useAdminRoute'

describe('parseAdminHash', () => {
  it('opens the overview on an empty hash and on "#/"', () => {
    expect(parseAdminHash('')).toEqual({ name: 'overview' })
    expect(parseAdminHash('#')).toEqual({ name: 'overview' })
    expect(parseAdminHash('#/')).toEqual({ name: 'overview' })
  })

  it('parses each screen', () => {
    expect(parseAdminHash('#/users')).toEqual({ name: 'users' })
    expect(parseAdminHash('#/jobs')).toEqual({ name: 'jobs' })
    expect(parseAdminHash('#/stats')).toEqual({ name: 'stats' })
    expect(parseAdminHash('#/audit')).toEqual({ name: 'audit' })
    expect(parseAdminHash('#/settings')).toEqual({ name: 'settings' })
  })

  it('ignores a trailing slash and a query string', () => {
    expect(parseAdminHash('#/users/')).toEqual({ name: 'users' })
    expect(parseAdminHash('#/jobs?result=failed&source=youtube')).toEqual({ name: 'jobs' })
  })

  it('parses a user card and decodes the uid', () => {
    expect(parseAdminHash('#/users/abc123')).toEqual({ name: 'user', uid: 'abc123' })
    expect(parseAdminHash('#/users/a%2Fb')).toEqual({ name: 'user', uid: 'a/b' })
  })

  it('keeps an undecodable uid as it is', () => {
    expect(parseAdminHash('#/users/%E0%A4%A')).toEqual({ name: 'user', uid: '%E0%A4%A' })
  })

  it('treats everything else as not found', () => {
    expect(parseAdminHash('#/nope')).toEqual({ name: 'notFound' })
    expect(parseAdminHash('#/users/a/b')).toEqual({ name: 'notFound' })
    expect(parseAdminHash('#/job/1')).toEqual({ name: 'notFound' })
  })
})

describe('adminPaths', () => {
  it('builds paths that parse back to the same route', () => {
    expect(parseAdminHash(`#${adminPaths.overview()}`)).toEqual({ name: 'overview' })
    expect(parseAdminHash(`#${adminPaths.users()}`)).toEqual({ name: 'users' })
    expect(parseAdminHash(`#${adminPaths.user('a/b c')}`)).toEqual({ name: 'user', uid: 'a/b c' })
    expect(parseAdminHash(`#${adminPaths.settings()}`)).toEqual({ name: 'settings' })
  })
})

describe('ADMIN_NAV', () => {
  it('lists the screens in the agreed order', () => {
    expect(ADMIN_NAV.map((n) => n.label)).toEqual(['Огляд', 'Користувачі', 'Задачі', 'Статистика', 'Журнал', 'Налаштування'])
  })
})
