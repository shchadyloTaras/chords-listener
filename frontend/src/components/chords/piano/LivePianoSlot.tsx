// Where the live piano goes in the chord workspace (under the now-playing hero): shown for the piano
// while settings.liveKeys is on. The panel and everything behind it load on demand.

import { lazy, Suspense } from 'react'
import { useApp } from '../../../store'

const LivePiano = lazy(() => import('./LivePiano'))

export function LivePianoSlot() {
  const show = useApp((s) => s.instrument === 'piano' && s.liveKeys)
  if (!show) return null
  return (
    <Suspense fallback={<div aria-hidden className="mt-3 h-[236px] rounded-[22px] border border-border bg-surface sm:h-[300px]" />}>
      <LivePiano />
    </Suspense>
  )
}
