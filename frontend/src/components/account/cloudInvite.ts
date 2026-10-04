import { useAuth } from '../../lib/auth'
import { cloudPrefix, useConnection } from '../../lib/serverMode'

/**
 * Whether signing in would bring the cloud in: a cloud is configured, nobody is signed in, and the page is
 * not served by a local server (there the same-origin server always answers).
 */
export function useCloudInvite(): boolean {
  const ready = useAuth((s) => s.ready)
  const signedIn = useAuth((s) => !!s.user)
  const sameOriginServer = useConnection((s) => s.status === 'server' && s.backend === 'local' && !s.remote)
  return !!cloudPrefix() && ready && !signedIn && !sameOriginServer
}
