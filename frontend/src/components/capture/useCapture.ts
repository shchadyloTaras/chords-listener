import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { CaptureError, captureMicrophone, captureTabAudio, startLiveSession, type LiveSession } from '../../lib/live'
import {
  captureReducer,
  initialCapture,
  isCapturing,
  MAX_RECORDING_S,
  MIN_RECORDING_S,
  sessionCommand,
  type CaptureEvent,
  type CaptureFailure,
  type CaptureState,
} from './machine'

export type CaptureSource = 'tab' | 'mic'

export interface CaptureRecording {
  audio: Blob
  mime: string
  /** seconds, pauses excluded */
  duration: number
}

interface UseCaptureOptions {
  /** Stores the recording (upload / browser analysis); resolves once its job exists, throws on failure. */
  save(recording: CaptureRecording): Promise<unknown>
  /** The recording stopped on its own: the time limit, or the user stopped sharing in the browser. */
  onAutoStop?(reason: 'limit' | 'ended'): void
}

/** The failure code and the technical cause (the browser's own message) of a rejected start. */
export function failureOf(err: unknown): { code: CaptureFailure; detail: string | null } {
  if (err instanceof CaptureError) return { code: err.code, detail: err.message === err.code ? null : err.message }
  const message = (err as { message?: unknown } | null | undefined)?.message
  return { code: 'failed', detail: String(message ?? err) }
}

/**
 * One listening session: captures the tab / microphone, runs the live chord session, follows the
 * state machine (machine.ts) and saves the recording at the end. `start` must run inside a click
 * (the browser only shows its capture prompt for a user gesture).
 */
export function useCapture({ save, onAutoStop }: UseCaptureOptions) {
  const [state, dispatchRaw] = useReducer(captureReducer, initialCapture)
  /** the live session (shown by LiveChordsView); kept after it stops, until the next start / reset */
  const [session, setSession] = useState<LiveSession | null>(null)
  const [recording, setRecording] = useState<CaptureRecording | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const stateRef = useRef<CaptureState>(state)
  const sessionRef = useRef<LiveSession | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingRef = useRef<CaptureRecording | null>(null)
  const saveRef = useRef(save)
  const autoStopRef = useRef(onAutoStop)
  const alive = useRef(true)
  const prevPhase = useRef(state.phase)
  useEffect(() => {
    saveRef.current = save
    autoStopRef.current = onAutoStop
  })

  const dispatch = useCallback((event: CaptureEvent) => {
    stateRef.current = captureReducer(stateRef.current, event)
    dispatchRaw(event)
  }, [])

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  /** Drops the session without keeping anything (cancel, unmount). */
  const discard = useCallback(() => {
    const s = sessionRef.current
    sessionRef.current = null
    if (s && s.state !== 'stopped') void s.stop().catch(() => undefined)
    releaseStream()
    setSession(null)
  }, [releaseStream])

  // the session follows the phase: pause / resume with the video, stop → keep the recording
  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = state.phase
    const command = sessionCommand(prev, state.phase)
    const s = sessionRef.current
    if (!command || !s) return
    if (command === 'pause') s.pause()
    else if (command === 'resume') s.resume()
    else {
      sessionRef.current = null
      s.stop().then(
        (result) => {
          releaseStream()
          if (!alive.current) return
          const usable = !!result.audio && result.audio.size > 0 && result.duration >= MIN_RECORDING_S
          if (usable && result.audio) {
            const rec = { audio: result.audio, mime: result.mimeType || result.audio.type, duration: result.duration }
            recordingRef.current = rec
            setRecording(rec)
          }
          dispatch({ type: 'recorded', usable })
        },
        () => {
          releaseStream()
          if (!alive.current) return
          dispatch({ type: 'recorded', usable: false })
        },
      )
    }
  }, [state.phase, dispatch, releaseStream])

  // saving: hand the recording over; it stays in memory until a job exists
  useEffect(() => {
    if (state.phase !== 'saving') return
    const rec = recordingRef.current
    if (!rec) {
      dispatch({ type: 'saveFailed' })
      return
    }
    setSaveError(null)
    saveRef.current(rec).then(
      () => {
        if (!alive.current) return
        recordingRef.current = null
        dispatch({ type: 'saved' })
      },
      (err: unknown) => {
        if (!alive.current) return
        setSaveError(err)
        dispatch({ type: 'saveFailed' })
      },
    )
  }, [state.phase, dispatch])

  /** Asks for the tab / microphone and opens the live session. `waitForMedia`: record only once the video plays. */
  const start = useCallback(
    async (source: CaptureSource, opts: { waitForMedia?: boolean } = {}): Promise<boolean> => {
      // read through a function: the state changes while this awaits the browser
      const phaseNow = () => stateRef.current.phase
      const ready = stateRef.current
      if (ready.phase !== 'idle' && !(ready.phase === 'error' && !ready.hasRecording)) return false
      const failed = (err: unknown) => {
        const { code, detail } = failureOf(err)
        dispatch({ type: 'failed', error: code, detail: detail ?? undefined })
      }
      dispatch({ type: 'start' })
      setSession(null)
      setRecording(null)
      recordingRef.current = null
      let stream: MediaStream
      try {
        stream = source === 'tab' ? await captureTabAudio() : await captureMicrophone()
      } catch (err) {
        if (alive.current) failed(err)
        return false
      }
      if (!alive.current || phaseNow() !== 'requesting') {
        stream.getTracks().forEach((track) => track.stop())
        return false
      }
      streamRef.current = stream
      let s: LiveSession
      try {
        s = await startLiveSession(stream, { record: true })
      } catch (err) {
        releaseStream()
        if (alive.current) failed(err)
        return false
      }
      if (!alive.current || phaseNow() !== 'requesting') {
        void s.stop().catch(() => undefined)
        releaseStream()
        return false
      }
      if (opts.waitForMedia) s.pause()
      sessionRef.current = s
      setSession(s)
      s.onUpdate((u) => {
        if (sessionRef.current !== s || !isCapturing(stateRef.current.phase)) return
        if (u.time >= MAX_RECORDING_S) {
          autoStopRef.current?.('limit')
          dispatch({ type: 'stop' })
        } else if (u.ended) {
          // the input stream ended ("Stop sharing" / the microphone went away): keep what was heard
          autoStopRef.current?.('ended')
          dispatch({ type: 'stop' })
        }
      })
      dispatch({ type: 'granted', waitForMedia: !!opts.waitForMedia })
      return true
    },
    [dispatch, releaseStream],
  )

  const cancel = useCallback(() => {
    discard()
    recordingRef.current = null
    setRecording(null)
    dispatch({ type: 'reset' })
  }, [discard, dispatch])

  const retrySave = useCallback(() => dispatch({ type: 'retrySave' }), [dispatch])

  // leaving the page mid-session: let go of the tab / microphone
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      discard()
    }
  }, [discard])

  // closing / reloading the tab while recording: the browser asks first
  const capturing = isCapturing(state.phase) || state.phase === 'stopping' || state.phase === 'saving'
  useEffect(() => {
    if (!capturing) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [capturing])

  /** The machine's state right now (event handlers outside React's render cycle, e.g. the YouTube player). */
  const current = useCallback(() => stateRef.current, [])

  return { state, current, dispatch, start, cancel, retrySave, session, recording, saveError }
}
