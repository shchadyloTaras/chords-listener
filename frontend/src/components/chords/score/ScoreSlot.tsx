// The score view ("Ноти") in the chord workspace. The view and OpenSheetMusicDisplay behind it load
// on demand, so the main bundle stays small.

import { lazy, Suspense } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useT } from '../../../i18n'

const ScoreView = lazy(() => import('./ScoreView'))

export function ScoreSlot() {
  const t = useT()
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[320px] items-center justify-center gap-2 rounded-[22px] border border-border bg-surface text-sm text-muted">
          <LoaderCircle size={15} className="animate-spin" aria-hidden />
          {t('score.render.lib')}
        </div>
      }
    >
      <ScoreView />
    </Suspense>
  )
}
