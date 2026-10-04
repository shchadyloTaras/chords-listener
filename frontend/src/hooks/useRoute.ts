import { useSyncExternalStore } from 'react'

/** Hash-based routes: #/ · #/job/<id> · #/track/<id> · #/demo */
export type Route =
  | { name: 'home' }
  | { name: 'job'; id: string }
  | { name: 'track'; id: string }
  | { name: 'demo' }
  | { name: 'notFound' }

export const paths = {
  home: () => '/',
  job: (id: string) => `/job/${encodeURIComponent(id)}`,
  track: (id: string) => `/track/${encodeURIComponent(id)}`,
  demo: () => '/demo',
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/'
  if (path === '/' || path === '') return { name: 'home' }
  if (path === '/demo') return { name: 'demo' }
  const m = /^\/(job|track)\/([^/?#]+)$/.exec(path)
  if (m) {
    let id = m[2]
    try {
      id = decodeURIComponent(id)
    } catch {
      /* keep raw */
    }
    return { name: m[1] as 'job' | 'track', id }
  }
  return { name: 'notFound' }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

const getHash = () => window.location.hash

/** Current route; re-renders on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, getHash)
  return parseHash(hash)
}

export function currentPath(): string {
  return window.location.hash.replace(/^#/, '') || '/'
}

/** Navigate to an app path such as "/track/abc". `replace` skips a history entry. */
export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const target = `#${path}`
  if (window.location.hash === target || (path === '/' && !window.location.hash)) return
  if (opts.replace) window.location.replace(target)
  else window.location.hash = path
}
