// A microphone recording: no live chords (they come from the full analysis of the recording), so the
// stage shows that it records — the status, a large elapsed time, a large level meter and one line
// of guidance (too quiet, paused, the microphone went away).

import { memo } from 'react'
import clsx from 'clsx'
import { useT } from '../../i18n'
import type { LiveSession } from '../../lib/live'
import { formatTime } from '../ui/format'
import { LiveLevelMeter } from './LiveLevelMeter'
import { recordingCaption } from './recording'
import { useQuiet } from './quiet'
import { StatusPill } from './status'
import { useLiveSession } from './useLiveSession'
import '../chords/chords.css'

export interface LiveRecordingViewProps {
  session: LiveSession | null
  /** shown in the header */
  title?: string
  className?: string
}

export const LiveRecordingView = memo(function LiveRecordingView({ session, title, className }: LiveRecordingViewProps) {
  const t = useT()
  const view = useLiveSession(session)
  const quiet = useQuiet(view)
  const running = view.state === 'running' && !view.ended
  const caption = recordingCaption(view, quiet)

  return (
    <section aria-label={t('live.rec.region')} className={clsx('cw-stage relative overflow-hidden rounded-[28px] border border-border', className)}>
      <div className="flex items-center gap-3 px-5 pt-4 sm:px-7 sm:pt-5">
        <StatusPill state={view.state} ended={!!view.ended} runningLabel={t('live.rec.status')} />
        {title && (
          <span className="min-w-0 truncate text-sm text-muted" title={title}>
            {title}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-5 pt-3 pb-5 sm:px-7 sm:pb-6">
        <span
          role="timer"
          aria-label={t('live.elapsed', { time: formatTime(view.time) })}
          className={clsx(
            'font-display leading-none font-semibold tracking-tight tabular-nums',
            running ? 'text-text' : 'text-muted',
          )}
          style={{ fontSize: 'clamp(3.6rem, 14vw, 7rem)' }}
        >
          {formatTime(view.time)}
        </span>
        <LiveLevelMeter level={view.level} active={running} segments={16} size="lg" className="mb-2" />
      </div>

      {caption && (
        <p
          className={clsx(
            'border-t border-border px-5 py-3 text-sm sm:px-7',
            caption.tone === 'warn' ? 'text-accent' : 'text-muted',
          )}
        >
          {t(caption.key)}
        </p>
      )}
    </section>
  )
})
