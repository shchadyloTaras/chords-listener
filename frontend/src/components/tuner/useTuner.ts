// The tuner page's microphone loop: start() asks for the microphone, then every animation frame reads
// the newest window, detects its pitch and steadies it for the display. It stops on stop(), on leaving
// the page and when the microphone goes away; detection waits while `paused` (the reference tone).

import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureError, captureMicrophone, type CaptureErrorCode } from '../../lib/live'
import { createPitchDetector } from '../../lib/tuner/pitch'
import { FRAME_SIZE, startTuner, type TunerInput } from '../../lib/tuner/session'
import { createStabilizer, type TunerReading } from '../../lib/tuner/stabilizer'

/** 'ended': the microphone went away while tuning (unplugged, taken by another app) */
export type TunerErrorCode = CaptureErrorCode | 'ended'

export type TunerState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running'; reading: TunerReading | null }
  | { phase: 'error'; code: TunerErrorCode; detail: string | null }

/** a reading is worth a render when the note changes or the needle moves this far */
const REDRAW_CENTS = 0.5

export function sameReading(a: TunerReading | null, b: TunerReading | null): boolean {
  if (!a || !b) return a === b
  return a.midi === b.midi && Math.abs(a.cents - b.cents) < REDRAW_CENTS
}

function failure(err: unknown): TunerState {
  if (err instanceof CaptureError) return { phase: 'error', code: err.code, detail: err.message !== err.code ? err.message : null }
  return { phase: 'error', code: 'failed', detail: err instanceof Error ? err.message : String(err) }
}

export function useTuner({ a4, paused }: { a4: number; paused: boolean }) {
  const [state, setState] = useState<TunerState>({ phase: 'idle' })
  /** the last note heard this visit (the reference tone's picker starts there) */
  const [lastMidi, setLastMidi] = useState<number | null>(null)
  const input = useRef<TunerInput | null>(null)
  const raf = useRef(0)
  /** bumped by every start and stop: a microphone granted to an abandoned start is released at once */
  const attempt = useRef(0)
  const a4Ref = useRef(a4)
  const pausedRef = useRef(paused)
  useEffect(() => {
    a4Ref.current = a4
    pausedRef.current = paused
  }, [a4, paused])

  const release = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    input.current?.stop()
    input.current = null
  }, [])

  const start = useCallback(async () => {
    const id = ++attempt.current
    release()
    setState({ phase: 'starting' })
    let stream: MediaStream
    try {
      stream = await captureMicrophone()
    } catch (err) {
      if (id === attempt.current) setState(failure(err))
      return
    }
    if (id !== attempt.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    let tuner: TunerInput
    try {
      tuner = startTuner(stream)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      setState(failure(err))
      return
    }
    input.current = tuner
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (input.current !== tuner) return
        release()
        setState({ phase: 'error', code: 'ended', detail: null })
      })
    }

    const detector = createPitchDetector(FRAME_SIZE)
    const stabilizer = createStabilizer()
    const frame = new Float32Array(FRAME_SIZE)
    let shown: TunerReading | null = null
    const tick = (now: number) => {
      if (input.current !== tuner) return
      let reading: TunerReading | null = null
      if (pausedRef.current) stabilizer.reset()
      else {
        const rms = tuner.read(frame)
        reading = stabilizer.push(detector.detect(frame, tuner.sampleRate), rms, now, a4Ref.current)
      }
      if (!sameReading(reading, shown)) {
        if (reading && reading.midi !== shown?.midi) setLastMidi(reading.midi)
        shown = reading
        setState({ phase: 'running', reading })
      }
      raf.current = requestAnimationFrame(tick)
    }
    setState({ phase: 'running', reading: null })
    raf.current = requestAnimationFrame(tick)
  }, [release])

  const stop = useCallback(() => {
    attempt.current++
    release()
    setState({ phase: 'idle' })
  }, [release])

  // leaving the page
  useEffect(
    () => () => {
      attempt.current++
      release()
    },
    [release],
  )

  return { state, lastMidi, start, stop }
}
