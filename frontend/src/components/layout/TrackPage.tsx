import { LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { ChordWorkspace } from '../chords'
import { sampleTrack } from '../../dev/sampleTrack'
import { useT } from '../../i18n'
import * as api from '../../lib/api'
import { toApiError, type ClientErrorCode } from '../../lib/api'
import { useApp } from '../../store'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { navigate, paths } from '../../hooks/useRoute'
import { errorText, errorTitle } from '../jobs/errorText'
import { PlayerBar } from '../player/PlayerBar'
import { PlayerHost } from '../player/PlayerHost'
import { Button } from '../ui/IconButton'


/** Loads a track (or the demo fixture) into the store; ChordWorkspace + sticky PlayerBar. */
export function TrackPage({ id, demo = false }: { id: string; demo?: boolean }) {
  const t = useT()
  const track = useApp((s) => s.track)
  const [attempt, setAttempt] = useState(0)
  // keyed by load attempt so a previous failure disappears on retry / navigation
  const loadKey = `${id}:${attempt}`
  const [failure, setFailure] = useState<{ key: string; code: ClientErrorCode } | null>(null)
  const errorCode = failure?.key === loadKey ? failure.code : null

  useEffect(() => {
    const { setTrack } = useApp.getState()
    if (demo) {
      setTrack(sampleTrack)
      return () => setTrack(null)
    }
    const ctrl = new AbortController()
    if (useApp.getState().track?.id !== id) setTrack(null)
    api
      .getTrack(id, ctrl.signal)
      .then((tr) => setTrack(tr))
      .catch((e) => {
        const err = toApiError(e)
        if (err.code !== 'aborted') setFailure({ key: `${id}:${attempt}`, code: err.code })
      })
    return () => {
      ctrl.abort()
      setTrack(null)
    }
  }, [id, demo, attempt])

  const ready = track !== null && track.id === (demo ? sampleTrack.id : id)
  useDocumentTitle(ready ? track.title : null)

  if (errorCode) {
    return (
      <div className="mx-auto max-w-md px-4 pt-20 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {errorCode === 'not_found' ? t('core.track.notFound') : errorTitle(errorCode)}
        </h1>
        <p className="mt-3 text-muted">{errorCode === 'not_found' ? t('core.track.notFoundHint') : errorText(errorCode)}</p>
        <div className="mt-6 flex justify-center gap-2">
          {errorCode !== 'not_found' && (
            <Button icon={<RotateCcw className="size-4" />} onClick={() => setAttempt((n) => n + 1)}>
              {t('core.retry')}
            </Button>
          )}
          <Button variant="primary" onClick={() => navigate(paths.home())}>
            {t('core.job.backHome')}
          </Button>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex justify-center pt-28 text-muted" role="status">
        <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t('core.loading')}</span>
      </div>
    )
  }

  // ChordWorkspace brings its own centered container, side gutters and bottom padding; here we only
  // reserve room for the docked video and tell it where the sticky header / player bar are:
  //  --chords-sticky-top: app header (h-14) + the docked video strip on narrow screens
  //  --chords-bottom-offset: floating chord overlays sit just above the PlayerBar
  return (
    <>
      <div
        className="w-full pt-[var(--video-dock-top,0px)] [--chords-sticky-top:calc(56px+var(--video-dock-top,0px))] lg:pt-0 lg:pr-[var(--video-dock-right,0px)] lg:[--chords-sticky-top:56px]"
        style={{ '--chords-bottom-offset': 'calc(var(--player-h, 96px) + 12px)' } as CSSProperties}
      >
        <ChordWorkspace />
      </div>
      <PlayerHost track={track} />
      <PlayerBar track={track} />
    </>
  )
}
