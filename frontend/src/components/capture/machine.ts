// Pure state machine of a listening session ("Слухати у вкладці" for a YouTube video, and "Слухати"
// from the microphone / a tab): what the UI shows and what the live session must do on each step.
// The hook (useCapture.ts) runs the side effects; everything here is testable without a browser.
import type { CaptureErrorCode } from '../../lib/live'
import { YT_STATE } from '../player/sources/youtubeApi'

export type CapturePhase =
  /** ready: the start button */
  | 'idle'
  /** the browser is asking to share the tab / use the microphone */
  | 'requesting'
  /** capturing, waiting for the video to start playing (the recording starts with it) */
  | 'starting'
  /** listening and recording */
  | 'live'
  /** the video (or the user) paused: analysis and recording wait */
  | 'paused'
  /** finishing the recording */
  | 'stopping'
  /** uploading / starting the analysis */
  | 'saving'
  /** the analysis job exists (the page moves on to it) */
  | 'done'
  | 'error'

export type CaptureFailure =
  | CaptureErrorCode
  /** the recording is too short to analyze */
  | 'too-short'
  /** the recording could not be saved (it is kept: retry or download) */
  | 'save'
  /** the YouTube player did not load */
  | 'player'
  /** the video may not be embedded on other sites */
  | 'embed'

export interface CaptureState {
  phase: CapturePhase
  error: CaptureFailure | null
  /** a finished recording is kept (failed save → retry / download) */
  hasRecording: boolean
}

export type CaptureEvent =
  | { type: 'start' }
  /** stream + live session are ready; `waitForMedia` = the recording starts when the video plays */
  | { type: 'granted'; waitForMedia: boolean }
  | { type: 'failed'; error: CaptureFailure }
  /** the media plays (video PLAYING, or the user resumed) */
  | { type: 'playing' }
  /** the media paused (video paused / buffering, or the user paused) */
  | { type: 'paused' }
  /** stop and save: the user, the end of the video, the time limit, or sharing was stopped */
  | { type: 'stop' }
  /** the session has stopped; `usable` = there is enough audio to analyze */
  | { type: 'recorded'; usable: boolean }
  | { type: 'saved' }
  | { type: 'saveFailed' }
  | { type: 'retrySave' }
  /** cancel / start over: back to the start button */
  | { type: 'reset' }

export const initialCapture: CaptureState = { phase: 'idle', error: null, hasRecording: false }

const CAPTURING: ReadonlySet<CapturePhase> = new Set<CapturePhase>(['starting', 'live', 'paused'])

/** The session is open (stream captured, not yet stopped). */
export function isCapturing(phase: CapturePhase): boolean {
  return CAPTURING.has(phase)
}

export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  const { phase } = state
  switch (event.type) {
    case 'start':
      return phase === 'idle' || (phase === 'error' && !state.hasRecording)
        ? { phase: 'requesting', error: null, hasRecording: false }
        : state
    case 'granted':
      return phase === 'requesting' ? { ...state, phase: event.waitForMedia ? 'starting' : 'live' } : state
    case 'failed':
      if (phase === 'done') return state
      return { phase: 'error', error: event.error, hasRecording: event.error === 'save' ? state.hasRecording : false }
    case 'playing':
      return phase === 'starting' || phase === 'paused' ? { ...state, phase: 'live' } : state
    case 'paused':
      return phase === 'live' ? { ...state, phase: 'paused' } : state
    case 'stop':
      return isCapturing(phase) ? { ...state, phase: 'stopping' } : state
    case 'recorded':
      if (phase !== 'stopping') return state
      return event.usable
        ? { phase: 'saving', error: null, hasRecording: true }
        : { phase: 'error', error: 'too-short', hasRecording: false }
    case 'saved':
      return phase === 'saving' ? { phase: 'done', error: null, hasRecording: false } : state
    case 'saveFailed':
      return phase === 'saving' ? { phase: 'error', error: 'save', hasRecording: true } : state
    case 'retrySave':
      return phase === 'error' && state.hasRecording ? { phase: 'saving', error: null, hasRecording: true } : state
    case 'reset':
      return initialCapture
  }
}

export type SessionCommand = 'pause' | 'resume' | 'stop'

/** What the live session must do when the phase changes from `prev` to `next`. */
export function sessionCommand(prev: CapturePhase, next: CapturePhase): SessionCommand | null {
  if (prev === next) return null
  if (next === 'live' && (prev === 'starting' || prev === 'paused')) return 'resume'
  if (next === 'paused') return 'pause'
  if (next === 'stopping') return 'stop'
  return null
}

/** The capture event for a YouTube player state (onStateChange). */
export function playerEvent(ytState: number): CaptureEvent | null {
  switch (ytState) {
    case YT_STATE.PLAYING:
      return { type: 'playing' }
    case YT_STATE.PAUSED:
    case YT_STATE.BUFFERING:
      return { type: 'paused' }
    case YT_STATE.ENDED:
      return { type: 'stop' }
    default:
      return null
  }
}

/**
 * Where the recording starts in the video: the position the user moved to, or the beginning (also when
 * the video is at / near its end). Rounded to 0.1 s.
 */
export function chooseStartOffset(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || currentTime < 1) return 0
  if (duration > 0 && currentTime >= duration - 2) return 0
  return Math.round(currentTime * 10) / 10
}

/** Shortest recording worth analyzing, seconds. */
export const MIN_RECORDING_S = 3
/** Longest recording (the server's and the browser engine's limit), seconds. */
export const MAX_RECORDING_S = 30 * 60
