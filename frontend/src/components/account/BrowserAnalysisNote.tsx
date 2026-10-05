import { Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { isLocalId } from '../../lib/local'
import { IconButton } from '../ui/IconButton'
import { AccountButtons } from './AccountCta'
import { dismissNote, noteDismissed } from './browserNote'
import { useCloudInvite } from './cloudInvite'

/**
 * One gentle hint on a song analyzed in the browser, for a guest who could sign in: what a free account adds
 * (a more precise server analysis, vocals, the library on every device). Closing it hides it for good.
 */
export function BrowserAnalysisNote({ trackId, className }: { trackId: string; className?: string }) {
  const t = useT()
  const invite = useCloudInvite()
  const [hidden, setHidden] = useState(noteDismissed)
  if (!invite || hidden || !isLocalId(trackId)) return null
  return (
    <div className={className}>
      <section
        aria-label={t('cloud.cta.title')}
        className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent-soft py-3 pr-2.5 pl-4 sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          <p className="min-w-0 text-sm leading-snug text-text">{t('account.note.browser')}</p>
        </div>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <AccountButtons size="sm" reason="accuracy" className="shrink-0" />
          <IconButton
            label={t('core.close')}
            size="sm"
            onClick={() => {
              dismissNote()
              setHidden(true)
            }}
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      </section>
    </div>
  )
}
