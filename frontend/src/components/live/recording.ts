// The microphone recording view's caption (pure): what the line under the timer says.
import type { LiveView } from './useLiveSession'

export type CaptionTone = 'muted' | 'warn'

export interface Caption {
  /** i18n key */
  key: string
  tone: CaptionTone
}

/** `quiet`: the input has been too quiet for a while (useQuiet). */
export function recordingCaption(view: Pick<LiveView, 'state' | 'ended'>, quiet: boolean): Caption | null {
  if (view.state === 'idle' || view.state === 'stopped') return null
  if (view.ended) return { key: 'live.ended.hint', tone: 'warn' }
  if (view.state === 'paused') return { key: 'live.paused.hint', tone: 'muted' }
  if (quiet) return { key: 'live.quiet', tone: 'warn' }
  return { key: 'live.rec.hint', tone: 'muted' }
}
