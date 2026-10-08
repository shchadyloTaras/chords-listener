// Cancelling a running vocal transcription (lib/vocals cancelVocals) from a button: the Score view's
// vocals card and the live keys panel. While the request is out the button is busy; a refusal is a toast.

import { useState } from 'react'
import { useT } from '../../i18n'
import { cancelVocals } from '../../lib/vocals'
import { useApp } from '../../store'
import type { Track } from '../../types'

export function useCancelVocals(track: Pick<Track, 'id'>): { cancelling: boolean; cancel(): void } {
  const t = useT()
  const [cancelling, setCancelling] = useState(false)
  const cancel = () => {
    setCancelling(true)
    cancelVocals(track)
      .catch((err: unknown) => {
        console.warn('[vocals] cancel failed:', err)
        useApp.getState().toast(t('score.vocals.cancelError'), 'error')
      })
      .finally(() => setCancelling(false))
  }
  return { cancelling, cancel }
}
