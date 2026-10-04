import { useEffect } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import { submitUrl } from '../../hooks/useJobs'
import { isTypingTarget } from '../../hooks/useHotkeys'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { toApiError } from '../../lib/api'
import { announceServerRequired } from '../../lib/serverMode'
import { RecentTracks } from '../history/RecentTracks'
import { SmartInput } from '../input/SmartInput'
import { startFiles } from '../input/startFiles'
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
        const url = check.url
        submitUrl(url).catch((err) => {
          const code = toApiError(err).code
          // no server (browser mode): the link field takes the link and explains how to connect one
          if (code === 'server_required' && announceServerRequired(url)) return
          useApp.getState().toast(errorText(code), 'error')
        })
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
    <div className="mx-auto w-full max-w-[52rem] px-4 pt-12 pb-24 sm:px-6 sm:pt-20">
      <h1 className="max-w-[16ch] font-display text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-[3.75rem]">
        {t('core.home.title')}
      </h1>
      <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-muted sm:text-lg">{t('core.home.subtitle')}</p>
      <SmartInput className="mt-9" />
      <RecentTracks />
    </div>
  )
}
