import { useSyncExternalStore } from 'react'

/**
 * Hash-based routes: #/ · #/job/<id> · #/track/<id> · #/demo ·
 * #/listen[?src=mic|tab][&title=<name>] (live chords from the microphone / a tab; the title names the recording) ·
 * #/listen/youtube/<videoId>[?blocked=1][&t=<s>] (play a YouTube video here and listen to this tab, from t) ·
 * #/youtube/<videoId>[?t=<s>] (pick a fragment of a YouTube video for the cloud, starting at t) ·
 * #/tuner (a chromatic tuner on the microphone)
 */
export type Route =
  | { name: 'home' }
  | { name: 'job'; id: string }
  | { name: 'track'; id: string }
  | { name: 'demo' }
  | { name: 'listen'; source: 'mic' | 'tab' | null; title: string | null }
  | { name: 'capture'; videoId: string; blocked: boolean; start: number | null }
  | { name: 'clip'; videoId: string; start: number | null }
  | { name: 'tuner' }
  | { name: 'notFound' }

/** `t=` of the YouTube routes: whole seconds, left out below 1. */
function setStart(q: URLSearchParams, t: number | null | undefined) {
  if (t !== undefined && t !== null && Number.isFinite(t) && t >= 1) q.set('t', String(Math.floor(t)))
}

function withQuery(path: string, q: URLSearchParams): string {
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

export const paths = {
  home: () => '/',
  job: (id: string) => `/job/${encodeURIComponent(id)}`,
  track: (id: string) => `/track/${encodeURIComponent(id)}`,
  demo: () => '/demo',
  tuner: () => '/tuner',
  listen: (source?: 'mic' | 'tab', opts: { title?: string } = {}) => {
    const q = new URLSearchParams()
    if (source) q.set('src', source)
    if (opts.title) q.set('title', opts.title.slice(0, 200))
    const s = q.toString()
    return s ? `/listen?${s}` : '/listen'
  },
  capture: (videoId: string, opts: { blocked?: boolean; t?: number | null } = {}) => {
    const q = new URLSearchParams()
    if (opts.blocked) q.set('blocked', '1')
    setStart(q, opts.t)
    return withQuery(`/listen/youtube/${encodeURIComponent(videoId)}`, q)
  },
  clip: (videoId: string, opts: { t?: number | null } = {}) => {
    const q = new URLSearchParams()
    setStart(q, opts.t)
    return withQuery(`/youtube/${encodeURIComponent(videoId)}`, q)
  },
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

function decodeVideoId(raw: string): string | null {
  let id = raw
  try {
    id = decodeURIComponent(raw)
  } catch {
    /* keep raw */
  }
  return VIDEO_ID_RE.test(id) ? id : null
}

function parseStart(raw: string | null): number | null {
  return raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : null
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
  const path = (q >= 0 ? raw.slice(0, q) : raw).replace(/\/+$/, '') || '/'
  if (path === '/' || path === '') return { name: 'home' }
  if (path === '/demo') return { name: 'demo' }
  if (path === '/tuner') return { name: 'tuner' }
  if (path === '/listen') {
    const src = query.get('src')
    return { name: 'listen', source: src === 'mic' || src === 'tab' ? src : null, title: query.get('title') || null }
  }
  const yt = /^\/listen\/youtube\/([^/?#]+)$/.exec(path)
  if (yt) {
    const videoId = decodeVideoId(yt[1])
    return videoId
      ? { name: 'capture', videoId, blocked: query.get('blocked') === '1', start: parseStart(query.get('t')) }
      : { name: 'notFound' }
  }
  const clip = /^\/youtube\/([^/?#]+)$/.exec(path)
  if (clip) {
    const videoId = decodeVideoId(clip[1])
    return videoId ? { name: 'clip', videoId, start: parseStart(query.get('t')) } : { name: 'notFound' }
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
