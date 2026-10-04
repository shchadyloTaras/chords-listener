import type { PlayerController } from '../../../store'

export type SourceKind = 'audio' | 'clock' | 'youtube'

/** A concrete playback backend the engine can hand playback between. */
export interface PlaybackSource extends PlayerController {
  readonly kind: SourceKind
  /** playing or about to play (buffering after play()) */
  isPlaying(): boolean
  /** 0 when unknown */
  getDuration(): number
  destroy(): void
}

export interface SourceEvents {
  onPlay(): void
  onPause(): void
  onEnded(): void
  onDuration(duration: number): void
  onError(code: string): void
}
