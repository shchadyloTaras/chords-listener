import clsx from 'clsx'
import { AppWindow, ArrowLeft, Download, FolderOpen, LoaderCircle, Mic, Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { t as tNow, useT } from '../../i18n'
import { toApiError } from '../../lib/api'
import { useConnection } from '../../lib/serverMode'
import { useApp } from '../../store'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useJobs } from '../../hooks/useJobs'
import { useCanListenInTab } from '../../hooks/useMediaQuery'
import { navigate, paths } from '../../hooks/useRoute'
import { listenReady } from '../../lib/tour/trigger'
import { useCloudInvite } from '../account/cloudInvite'
import { errorText } from '../jobs/errorText'
import { startFiles } from '../input/startFiles'
import { FILE_ACCEPT } from '../input/url'
import { useTourTrigger } from '../tour/hooks'
import { Button } from '../ui/IconButton'
import { LiveChordsView } from '../live'
import { CaptureErrorAlert } from './CaptureErrorAlert'
import { isCapturing, isRetryable, type CaptureFailure } from './machine'
import { recordingFilename, recordingTitle, saveRecording } from './saveRecording'
import { useCapture, type CaptureSource } from './useCapture'

/** `source`: what the failed attempt was listening to (a microphone refusal needs other words than a tab's). */
function failureText(error: CaptureFailure | null, reason: string, source: CaptureSource): string {
  if (!error) return ''
  if (error === 'too-short') return tNow('cloud.capture.tooShort')
  if (error === 'save') return tNow('cloud.capture.saveFailed', { reason })
  if (error === 'embed' || error === 'player') return tNow('cloud.capture.error.failed')
  return tNow(`${source === 'mic' ? 'live' : 'cloud.capture'}.error.${error}`)
}

function SourceCard({
  selected,
  disabled,
  icon,
  title,
  hint,
  note,
  onSelect,
}: {
  selected: boolean
  disabled?: boolean
  icon: ReactNode
  title: string
  hint: string
  note?: string
  onSelect(): void
}) {
  const hintId = useId()
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={title}
      aria-describedby={hintId}
      disabled={disabled}
      onClick={onSelect}
      className={clsx(
        'flex items-start gap-3.5 rounded-2xl border bg-surface px-4 py-4 text-left transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-55',
        selected ? 'border-accent shadow-[0_0_0_3px_var(--accent-soft)]' : 'border-border-strong hover:border-accent/50 hover:bg-surface-2',
      )}
    >
      <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-xl', selected ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-accent')}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[17px] leading-tight font-semibold tracking-tight text-text">{title}</span>
        <span id={hintId} className="mt-1 block text-sm leading-snug text-muted">
          {hint}
          {note && <span className="mt-1.5 block text-xs text-faint">{note}</span>}
        </span>
      </span>
    </button>
  )
}

/** Upload progress while the recording is being saved. */
function SavingLine() {
  const t = useT()
  const upload = useJobs((s) => s.uploads[s.uploads.length - 1])
  const pct = upload ? Math.round(upload.progress * 100) : null
  return (
    <div className="mt-4 flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3" role="status">
      <LoaderCircle className="size-5 shrink-0 animate-spin text-accent" aria-hidden="true" />
      <span className="flex-1 text-sm text-text">{pct === null ? t('cloud.capture.preparing') : t('cloud.capture.saving')}</span>
      {pct !== null && <span className="font-mono text-sm tabular-nums">{pct}%</span>}
    </div>
  )
}

/**
 * "Слухати" (#/listen): live chords from the microphone or a browser tab; Stop saves the recording as a
 * track (analyzed in the cloud when signed in, in this browser otherwise). `title` names the recording
 * (the capture page passes a video's title when the song plays on another device).
 */
export function ListenPage({ initialSource, title }: { initialSource: CaptureSource | null; title: string | null }) {
  const t = useT()
  const tabSupported = useCanListenInTab()
  const [source, setSource] = useState<CaptureSource>(initialSource === 'tab' && tabSupported ? 'tab' : 'mic')
  /** what the last attempt listened to: the picker may move on before the error is read */
  const [attempted, setAttempted] = useState<CaptureSource>(source)
  const fileRef = useRef<HTMLInputElement>(null)
  const cloud = useConnection((s) => s.backend === 'cloud')
  const cloudInvite = useCloudInvite()
  useDocumentTitle(t('cloud.listen.title'))

  const save = useCallback(
    (rec: { audio: Blob; mime: string }) => saveRecording(rec.audio, rec.mime, { title: title ?? recordingTitle() }),
    [title],
  )
  const capture = useCapture({
    save,
    onAutoStop: (reason) => useApp.getState().toast(tNow(reason === 'limit' ? 'cloud.capture.limit' : 'cloud.capture.ended'), 'info'),
  })
  const { state, dispatch } = capture
  const phase = state.phase
  const capturing = isCapturing(phase)
  const busy = phase === 'stopping' || phase === 'saving' || phase === 'done'
  // the Listen tour: at the start button; a recording keeps running if the tour is opened during it
  useTourTrigger('listen', listenReady(phase), capturing)

  const download = () => {
    const rec = capture.recording
    if (!rec) return
    const href = URL.createObjectURL(rec.audio)
    const a = document.createElement('a')
    a.href = href
    a.download = recordingFilename(title ?? recordingTitle(), rec.mime)
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
  }

  const saveNote = cloud ? t('cloud.listen.saveCloud') : cloudInvite ? t('cloud.listen.saveGuest') : null
  const errorMessage = state.error ? failureText(state.error, errorText(toApiError(capture.saveError).code), attempted) : ''
  // pressing "Start" again would fail the same way: a file is the way left
  const gaveUp = phase === 'error' && state.error !== null && !isRetryable(state.error)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">
      <Button
        variant="ghost"
        className="-ml-3"
        icon={<ArrowLeft className="size-4" />}
        onClick={() => {
          if (capturing) capture.cancel()
          navigate(paths.home())
        }}
      >
        {t('core.job.backHome')}
      </Button>

      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('cloud.listen.title')}</h1>
      <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted sm:text-base">{t('cloud.listen.subtitle')}</p>

      {capturing || busy ? (
        <div className="mt-6">
          <LiveChordsView session={capture.session} title={title ?? undefined} />
          {capturing && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted">
                {phase === 'paused' ? t('cloud.capture.paused') : t('cloud.listen.listening')} · {t('cloud.listen.limit')}
              </p>
              <div data-tour="listen.controls" className="flex gap-2">
                <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={capture.cancel} className="flex-1 sm:flex-none">
                  {t('cloud.listen.discard')}
                </Button>
                <Button
                  size="sm"
                  icon={phase === 'paused' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  onClick={() => dispatch(phase === 'paused' ? { type: 'playing' } : { type: 'paused' })}
                  className="flex-1 sm:flex-none"
                >
                  {phase === 'paused' ? t('cloud.capture.resume') : t('cloud.capture.pause')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Square className="size-3.5" fill="currentColor" />}
                  onClick={() => dispatch({ type: 'stop' })}
                  className="flex-[2] sm:flex-none"
                >
                  {t('cloud.listen.stop')}
                </Button>
              </div>
            </div>
          )}
          {busy && <SavingLine />}
        </div>
      ) : (
        <div className="mt-7">
          {phase === 'error' && <CaptureErrorAlert message={errorMessage} detail={state.detail} className="mb-5" />}

          {gaveUp ? (
            <>
              <Button variant="primary" icon={<FolderOpen className="size-4" aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
                {t('cloud.capture.phone.file')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept={FILE_ACCEPT}
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) startFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </>
          ) : phase === 'error' && state.hasRecording ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={capture.retrySave}>
                {t('cloud.capture.retrySave')}
              </Button>
              <Button icon={<Download className="size-4" />} onClick={download}>
                {t('cloud.capture.download')}
              </Button>
              <Button variant="ghost" onClick={capture.cancel}>
                {t('cloud.capture.cancel')}
              </Button>
            </div>
          ) : (
            <>
              <div role="radiogroup" data-tour="listen.sources" aria-label={t('cloud.listen.title')} className="grid gap-3 sm:grid-cols-2">
                <SourceCard
                  selected={source === 'mic'}
                  disabled={phase === 'requesting'}
                  icon={<Mic className="size-5" aria-hidden="true" />}
                  title={t('cloud.listen.mic.title')}
                  hint={t('cloud.listen.mic.hint')}
                  onSelect={() => setSource('mic')}
                />
                <SourceCard
                  selected={source === 'tab'}
                  disabled={!tabSupported || phase === 'requesting'}
                  icon={<AppWindow className="size-5" aria-hidden="true" />}
                  title={t('cloud.listen.tab.title')}
                  hint={t('cloud.listen.tab.hint')}
                  note={tabSupported ? undefined : t('cloud.listen.tab.unsupported')}
                  onSelect={() => setSource('tab')}
                />
              </div>
              <p className="mt-4 text-sm text-muted">{t(source === 'tab' ? 'cloud.listen.tab.howTo' : 'cloud.listen.mic.howTo')}</p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  data-tour="listen.start"
                  disabled={phase === 'requesting'}
                  icon={phase === 'requesting' ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" fill="currentColor" />}
                  onClick={() => {
                    setAttempted(source)
                    void capture.start(source)
                  }}
                  className="h-12 px-6 text-base"
                >
                  {t('cloud.listen.start')}
                </Button>
                {phase === 'requesting' && (
                  <span aria-live="polite" className="text-sm text-muted">
                    {t(source === 'tab' ? 'cloud.listen.requesting.tab' : 'cloud.listen.requesting.mic')}
                  </span>
                )}
              </div>
              <p className="mt-5 text-xs text-faint">
                {/* the "sign in" note only where signing in would bring the cloud in (not on a local server) */}
                {saveNote && `${saveNote} `}
                {t('cloud.listen.limit')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
