// The "too quiet" detector, shared by the live chords view and the microphone recording view.

import { useState } from 'react'
import type { LiveView } from './useLiveSession'

/** below this meter level (-50 dBFS, the analysis' silence floor) the input counts as silent / too quiet */
export const QUIET_LEVEL = 0.17
/** seconds of continuous quiet before the "turn it up" hint */
const QUIET_HINT_SEC = 4

/** True after QUIET_HINT_SEC of session time below QUIET_LEVEL while listening. */
export function useQuiet(view: LiveView): boolean {
  const [since, setSince] = useState<number | null>(null)
  const quietNow = view.state === 'running' && !view.ended && view.level < QUIET_LEVEL
  // derived from the previous renders (React's "adjusting state while rendering" pattern)
  if (quietNow && since === null) setSince(view.time)
  else if (!quietNow && since !== null) setSince(null)
  return quietNow && since !== null && view.time - since >= QUIET_HINT_SEC
}
