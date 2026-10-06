// Keeps the live library (lib/cloud/library) running exactly while it can: the cloud is the API and someone is
// signed in. A guest, a local server and browser mode never start it. (Sign-out and a change of account also stop
// it synchronously from lib/auth.ts, before the new session is visible.) Kept apart from library.ts so that
// auth.ts can import stopLibrary without a cycle.
import { useAuth } from '../auth'
import { useConnection } from '../serverMode'
import { startLibrary, stopLibrary } from './library'

/** Follows the session and the chosen API from now on; the returned function stops it and empties the library. Mount once in App. */
export function watchLibrary(): () => void {
  const sync = () => {
    const uid = useAuth.getState().user?.uid
    if (uid && useConnection.getState().backend === 'cloud') startLibrary(uid)
    else stopLibrary()
  }
  const stopAuth = useAuth.subscribe(sync)
  const stopConnection = useConnection.subscribe(sync)
  sync()
  return () => {
    stopAuth()
    stopConnection()
    stopLibrary()
  }
}
