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

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

const ID_RE = /^[A-Za-z0-9_-]{11}$/

/** Extracts an 11-char video id from common YouTube URL shapes. */
export function parseYouTubeId(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (!YT_HOSTS.has(host)) return null
  if (host.endsWith('youtu.be')) {
    const id = u.pathname.split('/')[1] ?? ''
    return ID_RE.test(id) ? id : null
  }
  const v = u.searchParams.get('v')
  if (v && ID_RE.test(v)) return v
  const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)
  return m ? m[1] : null
}

/**
 * Where a link goes. YouTube refuses the cloud's servers, so on the cloud (and without a server) a
 * YouTube video is listened to in the browser; a local server (home connection) downloads it.
 * Lives here, not in startLink.ts, so hooks/useJobs.ts can use it without an import cycle.
 */
export function linkTarget(url: string, conn: Pick<ConnectionState, 'status' | 'backend'>): 'capture' | 'server' | 'account' {
  const server = conn.status === 'server'
  if (parseYouTubeId(url)) return server && conn.backend === 'local' ? 'server' : 'capture'
  return server ? 'server' : 'account'
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
  const isYt = YT_HOSTS.has(u.hostname.toLowerCase())
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
