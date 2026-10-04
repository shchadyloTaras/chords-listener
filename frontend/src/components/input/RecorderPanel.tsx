import { CircleAlert, LoaderCircle, Mic, Square, X } from 'lucide-react'
import { useEffect } from 'react'
import { useT } from '../../i18n'
import { MAX_RECORDING_SEC, useRecorder } from '../../hooks/useRecorder'
import { submitFile } from '../../hooks/useJobs'
import { Button } from '../ui/IconButton'
import { formatTime } from '../ui/format'

/** Inline microphone recorder: live level meter + timer, stop → upload & analyze. */
export function RecorderPanel({ onClose }: { onClose(): void }) {
  const t = useT()
  const rec = useRecorder((file) => {
    onClose()
    void submitFile(file)
  })

  const { start } = rec
  // Ask for the mic as soon as the panel opens; the hook releases it on unmount.
  useEffect(() => {
    void start()
  }, [start])

  const stop = async () => {
    const file = await rec.stop()
    onClose()
    if (file) void submitFile(file)
  }

  const cancel = () => {
    rec.cancel()
    onClose()
  }

  if (rec.status === 'error') {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-danger/40 bg-surface p-4 sm:flex-row sm:items-center">
        <CircleAlert className="size-5 shrink-0 text-danger" aria-hidden="true" />
        <p className="flex-1 text-sm text-text">{t(`core.rec.error.${rec.error ?? 'failed'}`)}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('core.close')}
          </Button>
          <Button size="sm" onClick={() => void rec.start()}>
            {t('core.retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (rec.status !== 'recording') {
    return (
      <div className="flex min-h-16 items-center gap-3 rounded-2xl border border-border-strong bg-surface px-4 py-3">
        <LoaderCircle className="size-5 shrink-0 animate-spin text-muted" aria-hidden="true" />
        <p className="flex-1 text-sm text-muted">{t('core.rec.requesting')}</p>
        <Button size="sm" variant="ghost" onClick={cancel}>
          {t('core.cancel')}
        </Button>
      </div>
    )
  }

  const remaining = MAX_RECORDING_SEC - rec.elapsed
  return (
    <div>
      <div
        className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-danger/50 bg-surface px-4 py-3"
        aria-live="off"
      >
        <div className="flex items-center gap-2.5">
          <span className="relative flex size-3" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-3 rounded-full bg-danger" />
          </span>
          <span className="sr-only">{t('core.rec.recording')}</span>
          <span className="font-mono text-lg text-text tabular-nums">{formatTime(rec.elapsed)}</span>
        </div>
        <div className="flex h-8 min-w-24 flex-1 items-center gap-[3px]" aria-hidden="true">
          {rec.levels.map((lv, i) => (
            <span
              key={i}
              className="w-full max-w-1.5 min-w-[2px] flex-1 rounded-full bg-accent transition-[height] duration-75"
              style={{ height: `${Math.max(8, lv * 100)}%`, opacity: 0.35 + lv * 0.65 }}
            />
          ))}
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={cancel} className="flex-1 sm:flex-none">
            {t('core.cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Square className="size-3.5" fill="currentColor" />}
            onClick={() => void stop()}
            className="flex-[2] sm:flex-none"
          >
            {t('core.rec.stop')}
          </Button>
        </div>
      </div>
      <p className="mt-2.5 flex items-center gap-1.5 px-1 text-sm text-muted">
        <Mic className="size-3.5 shrink-0" aria-hidden="true" />
        {remaining < 60
          ? t('core.rec.endsSoon', { time: formatTime(Math.max(0, remaining)) })
          : t('core.rec.hint')}
      </p>
    </div>
  )
}
