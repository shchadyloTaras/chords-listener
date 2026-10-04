import { useEffect, useState } from 'react'
import type { LiveSession, LiveSessionState, LiveUpdate } from '../../lib/live'

/** The latest update of a session, with defaults while there is none ('idle' without a session). */
export interface LiveView extends Omit<LiveUpdate, 'state' | 'key' | 'tempo'> {
  state: LiveSessionState | 'idle'
  key: NonNullable<LiveUpdate['key']> | null
  tempo: number | null
}

const IDLE: LiveView = { time: 0, current: null, history: [], level: 0, key: null, tempo: null, state: 'idle' }

/**
 * Subscribes to a live session: re-renders on every update (at most ~10 per second while it
 * listens, plus state changes). Returns an idle view for `null`.
 */
export function useLiveSession(session: LiveSession | null): LiveView {
  const [update, setUpdate] = useState<{ session: LiveSession; u: LiveUpdate } | null>(null)

  useEffect(() => {
    if (!session) return
    // onUpdate replays the latest update right away
    return session.onUpdate((u) => setUpdate({ session, u }))
  }, [session])

  if (!session) return IDLE
  if (!update || update.session !== session) return { ...IDLE, state: session.state }
  const u = update.u
  return { ...u, key: u.key ?? null, tempo: u.tempo ?? null, state: u.state ?? session.state }
}
