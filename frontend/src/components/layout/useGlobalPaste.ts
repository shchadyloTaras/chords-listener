// Paste a link or a file anywhere on the home page (outside text fields) to start. Quiet while an aria-modal
// dialog is open (the tour, the account dialog, the shortcuts), the same check as the hotkeys.
import { useEffect } from 'react'
import { t as tNow } from '../../i18n'
import { isTypingTarget, modalOpen } from '../../hooks/useHotkeys'
import { toApiError } from '../../lib/api'
import { announceServerRequired } from '../../lib/serverMode'
import { useApp } from '../../store'
import { startFiles } from '../input/startFiles'
import { startLink } from '../input/startLink'
import { checkUrl, findUrl } from '../input/url'
import { errorText } from '../jobs/errorText'

export function useGlobalPaste(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (modalOpen() || isTypingTarget(e.target) || !e.clipboardData) return
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
