import { useSyncExternalStore } from 'react'

/**
 * Hash routes of the admin page (admin.html), modelled on hooks/useRoute.ts:
 * #/ (overview) · #/users · #/users/<uid> · #/jobs · #/stats · #/audit · #/settings
 */
export type AdminRoute =
  | { name: 'overview' }
  | { name: 'users' }
  | { name: 'user'; uid: string }
  | { name: 'jobs' }
  | { name: 'stats' }
  | { name: 'audit' }
  | { name: 'settings' }
  | { name: 'notFound' }

export const adminPaths = {
  overview: () => '/',
  users: () => '/users',
  user: (uid: string) => `/users/${encodeURIComponent(uid)}`,
  jobs: () => '/jobs',
  stats: () => '/stats',
  audit: () => '/audit',
  settings: () => '/settings',
}

/** The menu, in the agreed order (Ukrainian only, like the rest of the admin page: the admin is the owner). */
export const ADMIN_NAV: ReadonlyArray<{ label: string; path: string; match: ReadonlyArray<AdminRoute['name']> }> = [
  { label: 'Огляд', path: adminPaths.overview(), match: ['overview'] },
  { label: 'Користувачі', path: adminPaths.users(), match: ['users', 'user'] },
  { label: 'Задачі', path: adminPaths.jobs(), match: ['jobs'] },
  { label: 'Статистика', path: adminPaths.stats(), match: ['stats'] },
  { label: 'Журнал', path: adminPaths.audit(), match: ['audit'] },
  { label: 'Налаштування', path: adminPaths.settings(), match: ['settings'] },
]

const SCREENS: Record<string, AdminRoute> = {
  '/users': { name: 'users' },
  '/jobs': { name: 'jobs' },
  '/stats': { name: 'stats' },
  '/audit': { name: 'audit' },
  '/settings': { name: 'settings' },
}

export function parseAdminHash(hash: string): AdminRoute {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  const path = (q >= 0 ? raw.slice(0, q) : raw).replace(/\/+$/, '') || '/'
  if (path === '/') return { name: 'overview' }
  const screen = SCREENS[path]
  if (screen) return screen
  const m = /^\/users\/([^/]+)$/.exec(path)
  if (m) {
    let uid = m[1]
    try {
      uid = decodeURIComponent(uid)
    } catch {
      /* keep raw */
    }
    return { name: 'user', uid }
  }
  return { name: 'notFound' }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

const getHash = () => window.location.hash

/** Current admin route; re-renders on hash changes. */
export function useAdminRoute(): AdminRoute {
  const hash = useSyncExternalStore(subscribe, getHash, getHash)
  return parseAdminHash(hash)
}
