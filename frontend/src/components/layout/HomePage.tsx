import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useAuth } from '../../lib/auth'
import { useConnection } from '../../lib/serverMode'
import { homeReady, libraryState } from '../../lib/tour/trigger'
import { AccountCta } from '../account/AccountCta'
import { useTracks } from '../history/tracksStore'
import { RecentTracks } from '../history/RecentTracks'
import { SmartInput } from '../input/SmartInput'
import { useTourFlags, useTourTrigger } from '../tour/hooks'
import { useGlobalPaste } from './useGlobalPaste'

export function HomePage() {
  const t = useT()
  useDocumentTitle(null)
  useGlobalPaste()

  // the Home tour: once the mode, the account and the library are known (a failed library leaves both library steps out)
  const settled = useConnection((s) => s.status !== 'checking')
  const authReady = useAuth((s) => s.ready)
  const library = useTracks((s) => libraryState(s.tracks, s.error, s.pendingDelete))
  useTourFlags({ libraryEmpty: library === 'empty', libraryList: library === 'list' })
  useTourTrigger('home', homeReady({ settled, authReady, library }))

  return (
    <div className="mx-auto w-full max-w-[52rem] px-4 pt-10 pb-24 sm:px-6 sm:pt-16">
      <h1 className="max-w-[16ch] font-display text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-[3.75rem]">
        {t('core.home.title')}
      </h1>
      <p className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-muted sm:text-lg">{t('core.home.subtitle')}</p>
      <AccountCta className="mt-7" />
      <SmartInput className="mt-7" />
      <RecentTracks />
    </div>
  )
}
