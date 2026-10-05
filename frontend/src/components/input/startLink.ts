import { toApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { canListenInTab } from '../../lib/live/capture'
import { useConnection } from '../../lib/serverMode'
import { submitUrl } from '../../hooks/useJobs'
import { navigate, paths } from '../../hooks/useRoute'
import type { Job } from '../../types'
import { parseYouTubeId } from './url'

export type LinkStart =
  /** a server (cloud / own server) took the link: its job page is open */
  | { kind: 'job'; job: Job }
  /** no server, but this browser hears its tab: the YouTube video is played and listened to on the capture page */
  | { kind: 'capture'; videoId: string }
  /** no server and no way to listen here (another site, or YouTube on a phone / Safari / Firefox): only the cloud can fetch it (sign in) */
  | { kind: 'account' }

/**
 * Starts a link: the cloud / own server downloads it; without a server a YouTube video goes to "listen in
 * the tab" (the page plays it and hears this tab) where the browser can do that, everything else needs an
 * account. Throws ApiError otherwise.
 */
export async function startLink(url: string): Promise<LinkStart> {
  try {
    return { kind: 'job', job: await submitUrl(url) }
  } catch (e) {
    const err = toApiError(e)
    if (err.code !== 'server_required') throw err
    const videoId = parseYouTubeId(url)
    if (videoId && canListenInTab()) {
      navigate(paths.capture(videoId))
      return { kind: 'capture', videoId }
    }
    return { kind: 'account' }
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

/**
 * The capture page's video waiting for its guest to sign in: sent once the signed-in user's cloud is
 * connected. Another server connecting meanwhile (the user's own, or a local server coming back) is not a
 * sign-in: `giveUp` runs and nothing is sent (that server's usual page shows). Returns the cancel function.
 */
export function submitAfterSignIn(url: string, submit: (url: string) => void, giveUp: () => void): () => void {
  return submitWhenConnected(url, (link) => {
    if (useConnection.getState().backend === 'cloud' && useAuth.getState().user) submit(link)
    else giveUp()
  })
}
