// Public types of live listening (re-exported by ./index.ts, the module's entry point).

import type { KeyInfo } from '../../types'

export interface LiveChord {
  /** seconds since the session started (pauses excluded) */
  start: number
  end: number
  /** label per docs/SPEC.md (sharps), "N" = no chord */
  label: string
  confidence: number
  /** still being decided (inside the smoothing lag) */
  provisional: boolean
}

/** Diagnostics of the analysis (additive; for dev tools and the harness). */
export interface LiveStats {
  /** share of real time the analysis worker has spent computing this session (0.02 = 2 % of one core) */
  load: number
  /** seconds the chord analysis trails the input (feature windows) */
  delay: number
  /** estimated reference-pitch offset from A440 in semitones */
  tuning: number
}

export interface LiveUpdate {
  /** session time (s), pauses excluded */
  time: number
  current: LiveChord | null
  /** finished chords, oldest first (the newest ones may still be provisional) */
  history: LiveChord[]
  /** input level 0..1 for a meter */
  level: number
  key?: KeyInfo | null
  tempo?: number | null
  /** session state when this update was made (additive) */
  state?: LiveSessionState
  /** the input stream ended (e.g. "Stop sharing" was clicked): nothing more will arrive; call stop() (additive) */
  ended?: boolean
  /** the chord analysis failed; recording continues (additive) */
  error?: string
  stats?: LiveStats
}

export interface LiveResult {
  /** what was heard (when recording), e.g. audio/webm;codecs=opus */
  audio: Blob | null
  mimeType: string
  /** seconds, pauses excluded */
  duration: number
  chords: LiveChord[]
}

export type LiveSessionState = 'running' | 'paused' | 'stopped'

export interface LiveSession {
  readonly state: LiveSessionState
  /**
   * Updates arrive at most ~10 times per second while audio flows, plus once on every state
   * change. A new listener is called at once with the latest update, if there is one.
   */
  onUpdate(listener: (u: LiveUpdate) => void): () => void
  /** pause/resume analysis and recording together (e.g. when the YouTube video pauses) */
  pause(): void
  resume(): void
  stop(): Promise<LiveResult>
}

export interface LiveOptions {
  /** keep a recording of the stream (default true) */
  record?: boolean
  /**
   * leave the stream's tracks running after stop() / a failed start (default false: the
   * session owns the stream and stops it, which also ends tab sharing)
   */
  keepTracks?: boolean
  /** recording bitrate (default 128 kbps) */
  audioBitsPerSecond?: number
  /**
   * start paused: nothing is analyzed or recorded until resume() (e.g. until the video plays,
   * so the recording begins exactly there). Default false.
   */
  paused?: boolean
}

/**
 * `denied`: the user closed or cancelled the prompt; `blocked`: the browser, a permission policy or the
 * operating system refused without asking (a different fix).
 */
export type CaptureErrorCode = 'denied' | 'blocked' | 'no-audio' | 'unsupported' | 'insecure' | 'no-device' | 'failed'

export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string = code) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}
