// Which guided tours this device has seen (docs/superpowers/specs/2026-10-06-onboarding-tour-design.md):
// localStorage["chords-listener-tours"] = { "<tourId>": true }. Device-local on purpose — never in
// SYNCED_KEYS, nothing in Firestore. Blocked or broken storage reads as "nothing seen": the tour simply
// shows again (the same rule as components/account/browserNote.ts).

export const TOURS_KEY = 'chords-listener-tours'

export function seenTours(): Record<string, true> {
  try {
    const raw = localStorage.getItem(TOURS_KEY)
    if (!raw) return {}
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const seen: Record<string, true> = {}
    for (const [id, value] of Object.entries(data)) if (value === true) seen[id] = true
    return seen
  } catch {
    return {}
  }
}

export function isTourSeen(id: string): boolean {
  return seenTours()[id] === true
}

export function markTourSeen(id: string): void {
  try {
    localStorage.setItem(TOURS_KEY, JSON.stringify({ ...seenTours(), [id]: true }))
  } catch {
    /* storage blocked: the tour shows again next time */
  }
}
