// Client-side URL checks for the smart input. The backend (yt-dlp) is the final judge.
import type { ConnectionState } from '../../lib/serverMode'

export type UrlKind = 'youtube' | 'other'

export interface UrlCheck {
  ok: boolean
  /** normalized absolute URL when ok */
  url?: string
  kind?: UrlKind
  videoId?: string | null
}

/** YouTube's own hosts, as the server reads them (backend/app/sources.py `_is_youtube_host`). */
function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (['youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) return true
  return host === 'youtube.com' || host.endsWith('.youtube.com')
}

/** The link parsed, when it points at YouTube (any page: a video, a playlist, a channel). */
function youTubeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return isYouTubeHost(u.hostname) ? u : null
  } catch {
    return null
  }
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/
const ID_PATHS = new Set(['shorts', 'embed', 'v', 'e', 'live', 'watch'])

/** `decodeURIComponent` that leaves a malformed escape as it is (like Python's `unquote`). */
function unquote(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** The server's reading of a YouTube link (backend/app/sources.py `_youtube_id_from`): keep the two in step. */
function idFrom(host: string, path: string, query: URLSearchParams): string | null {
  const segments = path.split('/').filter(Boolean)
  if (host.endsWith('youtu.be')) return segments[0] && ID_RE.test(segments[0]) ? segments[0] : null
  const v = query.get('v') || query.get('vi') || ''
  if (ID_RE.test(v)) return v
  if (segments.length >= 2 && ID_PATHS.has(segments[0]) && ID_RE.test(segments[1])) return segments[1]
  if (segments[0] === 'attribution_link') {
    // a shared link: the video's own link (often just "/watch?v=…") is in `u`
    const inner = unquote(query.get('u') ?? '')
    if (!inner) return null
    try {
      const u = new URL(inner.includes('://') ? inner : `https://www.youtube.com${inner}`)
      return idFrom('www.youtube.com', u.pathname, u.searchParams)
    } catch {
      return null
    }
  }
  return null
}

/** Extracts the 11-char video id from every YouTube URL shape the server knows; null for anything else. */
export function parseYouTubeId(raw: string): string | null {
  const u = youTubeUrl(raw)
  return u ? idFrom(u.hostname.toLowerCase().replace(/\.$/, ''), u.pathname, u.searchParams) : null
}

/**
 * Where a link goes. A local server (home connection) downloads every link itself. Signed in on the cloud, a YouTube
 * video opens the fragment picker: the cloud downloads 30 s of it through chords-fetch (YouTube refuses the cloud's
 * own servers). Without an account a video is listened to in the browser ('capture'). Any other YouTube page (a
 * playlist, a channel, a clip) is not one video: 'notVideo', nothing is sent anywhere. Lives here, not in
 * startLink.ts, so hooks/useJobs.ts can use it without an import cycle.
 */
export function linkTarget(
  url: string,
  conn: Pick<ConnectionState, 'status' | 'backend'>,
): 'clip' | 'capture' | 'notVideo' | 'server' | 'account' {
  const server = conn.status === 'server'
  if (server && conn.backend === 'local') return 'server'
  if (youTubeUrl(url)) {
    if (!parseYouTubeId(url)) return 'notVideo'
    return server && conn.backend === 'cloud' ? 'clip' : 'capture'
  }
  return server ? 'server' : 'account'
}

/** A YouTube link's own start (`t=72`, `t=1m12s`, `start=30`, `#t=45`) in whole seconds; null when it has none. */
export function parseYouTubeStart(raw: string): number | null {
  const u = youTubeUrl(raw)
  if (!u) return null
  const value = (u.searchParams.get('t') ?? u.searchParams.get('start') ?? new URLSearchParams(u.hash.slice(1)).get('t') ?? '').trim()
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value)
  if (!value || !m) return null
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return seconds > 0 ? seconds : null
}

/** Accepts "youtube.com/…", "www.…", "youtu.be/…" without a scheme. */
function withScheme(text: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  if (/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(text) || /^www\./i.test(text)) return `https://${text}`
  if (/^[\w-]+(\.[\w-]+)+\/\S*$/.test(text)) return `https://${text}`
  return text
}

export function checkUrl(input: string): UrlCheck {
  const text = input.trim()
  if (!text || /\s/.test(text)) return { ok: false }
  let u: URL
  try {
    u = new URL(withScheme(text))
  } catch {
    return { ok: false }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false }
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return { ok: false }
  const url = u.toString()
  const isYt = isYouTubeHost(u.hostname)
  return { ok: true, url, kind: isYt ? 'youtube' : 'other', videoId: isYt ? parseYouTubeId(url) : null }
}

/** Finds the first http(s) URL in arbitrary pasted text. */
export function findUrl(text: string): string | null {
  const m = /(https?:\/\/[^\s<>"']+|(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"']+)/i.exec(text)
  return m ? m[1] : null
}

const MEDIA_EXT = new Set([
  'mp3', 'm4a', 'aac', 'wav', 'wave', 'aif', 'aiff', 'flac', 'ogg', 'oga', 'opus', 'wma', 'alac', 'caf',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp', 'amr',
])

/** True for files the backend can likely decode (audio/video MIME or a known extension). */
export function isMediaFile(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_EXT.has(ext)
}

export const FILE_ACCEPT = 'audio/*,video/*,.mp3,.m4a,.aac,.wav,.aiff,.flac,.ogg,.opus,.mp4,.mov,.webm,.mkv'
