import type { Track } from '../../types'
import { parseYouTubeId } from '../input/url'

/** YouTube video id for a track, if it came from YouTube. */
export function trackVideoId(track: Track): string | null {
  if (track.source.type !== 'youtube') return null
  return track.source.videoId || (track.source.url ? parseYouTubeId(track.source.url) : null)
}

/** Public link to the original video / page, if any. */
export function sourceHref(track: Track): string | null {
  const url = track.source.url
  if (url && /^https?:\/\//i.test(url)) return url
  const videoId = trackVideoId(track)
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null
}
