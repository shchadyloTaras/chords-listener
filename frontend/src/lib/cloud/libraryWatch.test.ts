// When the live library runs: only with the cloud as the API and someone signed in; anything else stops it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const library = vi.hoisted(() => ({ startLibrary: vi.fn(), stopLibrary: vi.fn() }))
vi.mock('./library', () => library)

import { useAuth } from '../auth'
import { useConnection } from '../serverMode'
import { watchLibrary } from './libraryWatch'

const SIGNED_IN = { user: { uid: 'u1', email: 'a@example.com' }, ready: true }
let stop: (() => void) | undefined

beforeEach(() => {
  useAuth.setState({ user: null, ready: true })
  useConnection.setState({ status: 'checking', backend: null })
  library.startLibrary.mockClear()
  library.stopLibrary.mockClear()
})

afterEach(() => {
  stop?.()
  stop = undefined
})

describe('watchLibrary', () => {
  it('does nothing for a guest, whichever API answers', () => {
    stop = watchLibrary()
    useConnection.setState({ status: 'server', backend: 'cloud' })
    useConnection.setState({ status: 'server', backend: 'local' })
    useConnection.setState({ status: 'browser', backend: null })
    expect(library.startLibrary).not.toHaveBeenCalled()
  })

  it('does not start for a signed-in user of a local server or of browser mode', () => {
    useAuth.setState(SIGNED_IN)
    stop = watchLibrary()
    useConnection.setState({ status: 'server', backend: 'local' })
    useConnection.setState({ status: 'browser', backend: null })
    expect(library.startLibrary).not.toHaveBeenCalled()
  })

  it('starts for the signed-in user once the cloud is the API', () => {
    useAuth.setState(SIGNED_IN)
    stop = watchLibrary()
    expect(library.startLibrary).not.toHaveBeenCalled()
    useConnection.setState({ status: 'server', backend: 'cloud' })
    expect(library.startLibrary).toHaveBeenLastCalledWith('u1')
  })

  it('starts when the user signs in on the cloud', () => {
    useConnection.setState({ status: 'server', backend: 'cloud' })
    stop = watchLibrary()
    expect(library.startLibrary).not.toHaveBeenCalled()
    useAuth.setState(SIGNED_IN)
    expect(library.startLibrary).toHaveBeenLastCalledWith('u1')
  })

  it('starts at once when the session and the cloud are already there', () => {
    useAuth.setState(SIGNED_IN)
    useConnection.setState({ status: 'server', backend: 'cloud' })
    stop = watchLibrary()
    expect(library.startLibrary).toHaveBeenCalledWith('u1')
  })

  it('follows another account', () => {
    useAuth.setState(SIGNED_IN)
    useConnection.setState({ status: 'server', backend: 'cloud' })
    stop = watchLibrary()
    useAuth.setState({ user: { uid: 'u2', email: 'b@example.com' } })
    expect(library.startLibrary).toHaveBeenLastCalledWith('u2')
  })

  it('stops on sign-out and when the cloud is left', () => {
    useAuth.setState(SIGNED_IN)
    useConnection.setState({ status: 'server', backend: 'cloud' })
    stop = watchLibrary()
    library.stopLibrary.mockClear()
    useAuth.setState({ user: null })
    expect(library.stopLibrary).toHaveBeenCalledTimes(1)

    useAuth.setState(SIGNED_IN)
    library.stopLibrary.mockClear()
    useConnection.setState({ status: 'server', backend: 'local' })
    expect(library.stopLibrary).toHaveBeenCalledTimes(1)
  })

  it('the stop function ends the library and stops following', () => {
    useAuth.setState(SIGNED_IN)
    useConnection.setState({ status: 'server', backend: 'cloud' })
    const unwatch = watchLibrary()
    library.startLibrary.mockClear()
    library.stopLibrary.mockClear()
    unwatch()
    expect(library.stopLibrary).toHaveBeenCalledTimes(1)
    useAuth.setState({ user: { uid: 'u2', email: null } })
    useConnection.setState({ status: 'server', backend: 'cloud', checkedAt: 1 })
    expect(library.startLibrary).not.toHaveBeenCalled()
    expect(library.stopLibrary).toHaveBeenCalledTimes(1)
  })
})
