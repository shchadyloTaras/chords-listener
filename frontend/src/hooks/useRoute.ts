import { useSyncExternalStore } from 'react'

/**
 * Hash-based routes: #/ · #/job/<id> · #/track/<id> · #/demo ·
 * #/listen[?src=mic|tab][&title=<name>] (live chords from the microphone / a tab; the title names the recording) ·
 * #/listen/youtube/<videoId>[?blocked=1] (play a YouTube video here and listen to this tab)
 */
export type Route =
  | { name: 'home' }
  | { name: 'job'; id: string }
  | { name: 'track'; id: string }
  | { name: 'demo' }
  | { name: 'listen'; source: 'mic' | 'tab' | null; title: string | null }
  | { name: 'capture'; videoId: string; blocked: boolean }
  | { name: 'notFound' }

export const paths = {
  home: () => '/',
  job: (id: string) => `/job/${encodeURIComponent(id)}`,
  track: (id: string) => `/track/${encodeURIComponent(id)}`,
  demo: () => '/demo',
  listen: (source?: 'mic' | 'tab', opts: { title?: string } = {}) => {
    const q = new URLSearchParams()
    if (source) q.set('src', source)
    if (opts.title) q.set('title', opts.title.slice(0, 200))
    const s = q.toString()
    return s ? `/listen?${s}` : '/listen'
  },
  capture: (videoId: string, opts: { blocked?: boolean } = {}) =>
    `/listen/youtube/${encodeURIComponent(videoId)}${opts.blocked ? '?blocked=1' : ''}`,
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
  const path = (q >= 0 ? raw.slice(0, q) : raw).replace(/\/+$/, '') || '/'
  if (path === '/' || path === '') return { name: 'home' }
  if (path === '/demo') return { name: 'demo' }
  if (path === '/listen') {
    const src = query.get('src')
    return { name: 'listen', source: src === 'mic' || src === 'tab' ? src : null, title: query.get('title') || null }
  }
  const yt = /^\/listen\/youtube\/([^/?#]+)$/.exec(path)
  if (yt) {
    let id = yt[1]
    try {
      id = decodeURIComponent(id)
    } catch {
      /* keep raw */
    }
    return VIDEO_ID_RE.test(id) ? { name: 'capture', videoId: id, blocked: query.get('blocked') === '1' } : { name: 'notFound' }
  }
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
