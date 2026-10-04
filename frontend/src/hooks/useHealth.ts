import { create } from 'zustand'
import { probeServer, useConnection, useConnectionPolling, type ConnectionState } from '../lib/serverMode'
import type { Health } from '../types'

export type HealthStatus = 'checking' | 'ok' | 'down'

interface HealthState {
  status: HealthStatus
  health: Health | null
  checkedAt: number
}

export const useHealth = create<HealthState>()(() => ({ status: 'checking', health: null, checkedAt: 0 }))

// Mirrors the connection state of lib/serverMode (which also knows about the hosted / browser modes):
// "ok" = a healthy server is connected, "down" = no server (browser mode) or an unhealthy one.
function fromConnection(c: ConnectionState): HealthState {
  const status: HealthStatus = c.status === 'checking' ? 'checking' : c.status === 'server' && c.health?.ok ? 'ok' : 'down'
  return { status, health: c.health, checkedAt: c.checkedAt }
}
useHealth.setState(fromConnection(useConnection.getState()))
useConnection.subscribe((c) => useHealth.setState(fromConnection(c)))

/** Checks for the server once (deduplicated). */
export function checkHealth(): Promise<void> {
  return probeServer().then(() => undefined)
}

/** Looks for the server on start, on tab focus and periodically (see useConnectionPolling). */
export function useHealthPolling() {
  useConnectionPolling()
}
