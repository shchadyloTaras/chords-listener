import { toApiError } from '../../lib/api'
import { submitUrl } from '../../hooks/useJobs'
import { navigate, paths } from '../../hooks/useRoute'
import type { Job } from '../../types'
import { parseYouTubeId } from './url'

export type LinkStart =
  /** a server (cloud / own server) took the link: its job page is open */
  | { kind: 'job'; job: Job }
  /** no server: the YouTube video is played and listened to on the capture page */
  | { kind: 'capture'; videoId: string }
  /** no server and not YouTube: only the cloud can fetch it (sign in) */
  | { kind: 'account' }

/**
 * Starts a link: the cloud / own server downloads it; without a server a YouTube video goes to "listen in
 * the tab" (the page plays it and hears this tab), other sites need an account. Throws ApiError otherwise.
 */
export async function startLink(url: string): Promise<LinkStart> {
  try {
    return { kind: 'job', job: await submitUrl(url) }
  } catch (e) {
    const err = toApiError(e)
    if (err.code !== 'server_required') throw err
    const videoId = parseYouTubeId(url)
    if (videoId) {
      navigate(paths.capture(videoId))
      return { kind: 'capture', videoId }
    }
    return { kind: 'account' }
  }
}
