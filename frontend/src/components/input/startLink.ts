import { ApiError, toApiError } from '../../lib/api'
import { useConnection, whenSettled } from '../../lib/serverMode'
import { submitUrl } from '../../hooks/useJobs'
import { youtubeEnabled } from '../../lib/serviceStatus'
import { navigate, paths } from '../../hooks/useRoute'
import type { Job } from '../../types'
import { linkTarget, parseYouTubeId, parseYouTubeStart } from './url'

export { linkTarget } from './url'

export type LinkStart =
  /** a server took the link: its job page is open */
  | { kind: 'job'; job: Job }
  /** signed in on the cloud: a YouTube video opens the fragment picker */
  | { kind: 'clip'; videoId: string }
  /** a YouTube video: played and listened to on the capture page (tab, or the on-device ways) */
  | { kind: 'capture'; videoId: string }
  /** a YouTube page that is not one video (a playlist, a channel): nothing to listen to, nothing sent */
  | { kind: 'notVideo' }
  /** another site and no server: only the cloud can fetch it (sign in) */
  | { kind: 'account' }

/**
 * Starts a link (see linkTarget). Throws ApiError when the server refuses it; a cancelled start (`signal`)
 * throws code 'aborted' and opens nothing.
 */
export async function startLink(url: string, signal?: AbortSignal): Promise<LinkStart> {
  // still choosing the API (auth restoring, first probe): wait, so a cloud user is not treated as a guest
  const conn = useConnection.getState().status === 'checking' ? await whenSettled() : useConnection.getState()
  if (signal?.aborted) throw new ApiError('Request aborted', 'aborted')
  const linked = linkTarget(url, conn)
  // the admin switched the cloud's YouTube download off (AC-27): the fragment picker would only be refused
  const target = linked === 'clip' && !youtubeEnabled() ? 'capture' : linked
  const videoId = parseYouTubeId(url)
  if (target === 'clip' && videoId) {
    navigate(paths.clip(videoId, { t: parseYouTubeStart(url) }))
    return { kind: 'clip', videoId }
  }
  if (target === 'capture' && videoId) {
    navigate(paths.capture(videoId))
    return { kind: 'capture', videoId }
  }
  if (target === 'notVideo') return { kind: 'notVideo' }
  if (target === 'account') return { kind: 'account' }
  try {
    return { kind: 'job', job: await submitUrl(url, undefined, signal) }
  } catch (e) {
    const err = toApiError(e)
    if (err.code === 'server_required') return { kind: 'account' }
    throw err
  }
}

/**
 * A link that waits for an account: calls `submit(url)` once a server is connected (signing in brings in
 * the cloud), at most once. The returned function cancels the wait (the prompt was dismissed or replaced,
 * the page was left).
 */
export function submitWhenConnected(url: string, submit: (url: string) => void): () => void {
  let waiting = true
  const check = () => {
    if (!waiting || useConnection.getState().status !== 'server') return
    cancel()
    submit(url)
  }
  const unsubscribe = useConnection.subscribe(check)
  const cancel = () => {
    waiting = false
    unsubscribe()
  }
  check()
  return cancel
}
