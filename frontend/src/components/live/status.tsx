// The session status pill, shared by the live chords view and the microphone recording view.

import { Pause, Square } from 'lucide-react'
import { useT } from '../../i18n'
import type { LiveView } from './useLiveSession'

/** `runningLabel`: the pill's text while it runs (default «Наживо»). */
export function StatusPill({ state, ended, runningLabel }: { state: LiveView['state']; ended: boolean; runningLabel?: string }) {
  const t = useT()
  if (state === 'running' && !ended) {
    return (
      <span className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full bg-danger/12 px-2.5 text-xs font-semibold tracking-wider text-danger uppercase">
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-danger" />
        </span>
        {runningLabel ?? t('live.status.running')}
      </span>
    )
  }
  const label = ended && state !== 'stopped' ? t('live.status.ended') : t(`live.status.${state}`)
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-semibold tracking-wider text-muted uppercase">
      {state === 'paused' ? (
        <Pause aria-hidden className="size-3" fill="currentColor" />
      ) : state === 'stopped' ? (
        <Square aria-hidden className="size-2.5" fill="currentColor" />
      ) : (
        <span aria-hidden className="size-2 rounded-full bg-border-strong" />
      )}
      <span className="max-w-[14rem] truncate normal-case tracking-normal sm:uppercase sm:tracking-wider">{label}</span>
    </span>
  )
}
