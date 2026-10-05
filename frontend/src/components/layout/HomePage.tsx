import { useEffect } from 'react'
import { t as tNow, useT } from '../../i18n'
import { useApp } from '../../store'
import { isTypingTarget } from '../../hooks/useHotkeys'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { toApiError } from '../../lib/api'
import { announceServerRequired } from '../../lib/serverMode'
import { AccountCta } from '../account/AccountCta'
import { RecentTracks } from '../history/RecentTracks'
import { SmartInput } from '../input/SmartInput'
import { startFiles } from '../input/startFiles'
import { startLink } from '../input/startLink'
import { checkUrl, findUrl } from '../input/url'
import { errorText } from '../jobs/errorText'

/** Paste a link or a file anywhere on the home page (outside text fields) to start. */
function useGlobalPaste() {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || !e.clipboardData) return
      if (e.clipboardData.files.length) {
        e.preventDefault()
        startFiles(e.clipboardData.files)
        return
      }
      const url = findUrl(e.clipboardData.getData('text'))
      const check = url ? checkUrl(url) : null
      if (check?.ok && check.url) {
        e.preventDefault()
        const link = check.url
        startLink(link).then(
          (started) => {
            // another site without a server: the link field takes it and explains the account
            if (started.kind === 'account' && !announceServerRequired(link))
              useApp.getState().toast(errorText('server_required'), 'info')
            // a YouTube playlist or channel: nothing was sent, say what to paste instead
            if (started.kind === 'notVideo') useApp.getState().toast(tNow('cloud.input.notVideo'), 'info')
          },
          (err) => useApp.getState().toast(errorText(toApiError(err).code), 'error'),
        )
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])
}

export function HomePage() {
  const t = useT()
  useDocumentTitle(null)
  useGlobalPaste()

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
