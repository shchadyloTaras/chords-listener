import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'error'
export type RecorderError = 'denied' | 'no-device' | 'insecure' | 'unsupported' | 'failed'

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
const LEVEL_HISTORY = 40
/** Same as the backend's default duration limit. */
export const MAX_RECORDING_SEC = 30 * 60

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
}

function extFor(mime: string): string {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

function recordingName(mime: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`
  return `${t('core.rec.fileTitle')} ${stamp}.${extFor(mime)}`
}

interface Session {
  stream: MediaStream
  recorder: MediaRecorder
  chunks: Blob[]
  ctx: AudioContext
  raf: number
  startedAt: number
}

const silentLevels = () => Array<number>(LEVEL_HISTORY).fill(0)

/**
 * Microphone recorder with a live level meter.
 * `levels` is a rolling history (0..1) for drawing a meter, `elapsed` is in seconds.
 * `onAutoStop` receives the file when the maximum duration is reached.
 */
export function useRecorder(onAutoStop?: (file: File) => void) {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [error, setError] = useState<RecorderError | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>(silentLevels)
  const session = useRef<Session | null>(null)
  const starting = useRef(false)
  const alive = useRef(true)
  const autoStopRef = useRef(onAutoStop)
  useEffect(() => {
    autoStopRef.current = onAutoStop
  })

  const teardown = useCallback(() => {
    const s = session.current
    if (!s) return
    session.current = null
    cancelAnimationFrame(s.raf)
    if (s.recorder.state !== 'inactive') {
      try {
        s.recorder.stop()
      } catch {
        /* already stopped */
      }
    }
    s.stream.getTracks().forEach((track) => track.stop())
    void s.ctx.close().catch(() => undefined)
  }, [])

  const finish = useCallback(
    (keep: boolean): Promise<File | null> => {
      const s = session.current
      if (!s) return Promise.resolve(null)
      return new Promise((resolve) => {
        const { recorder, chunks } = s
        const done = () => {
          teardown()
          setStatus('idle')
          setElapsed(0)
          setLevels(silentLevels())
          if (!keep || !chunks.length) return resolve(null)
          const type = recorder.mimeType || chunks[0].type || 'audio/webm'
          resolve(new File(chunks, recordingName(type), { type: type.split(';')[0] }))
        }
        if (recorder.state === 'inactive') return done()
        recorder.addEventListener('stop', done, { once: true })
        recorder.stop()
      })
    },
    [teardown],
  )

  const begin = useCallback(async () => {
    setError(null)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(window.isSecureContext ? 'unsupported' : 'insecure')
      setStatus('error')
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('unsupported')
      setStatus('error')
      return
    }
    setStatus('requesting')
    let stream: MediaStream
    try {
      // Music, not speech: turn the voice-call processing off.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      setError(
        name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'no-device' : 'failed',
      )
      setStatus('error')
      return
    }
    if (!alive.current) {
      // unmounted while the permission prompt was open
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    try {
      const mimeType = pickMime()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined)
      const chunks: Blob[] = []
      recorder.ondataavailable = (ev) => {
        if (ev.data.size) chunks.push(ev.data)
      }
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const s: Session = { stream, recorder, chunks, ctx, raf: 0, startedAt: performance.now() }
      session.current = s

      let lastPush = 0
      const tick = (now: number) => {
        if (session.current !== s) return
        if (now - lastPush > 60) {
          lastPush = now
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length)
          // perceptual-ish scaling: -48 dBFS..0 → 0..1
          const db = 20 * Math.log10(rms || 1e-6)
          const level = Math.max(0, Math.min(1, (db + 48) / 48))
          setLevels((prev) => [...prev.slice(1), level])
          const sec = (now - s.startedAt) / 1000
          setElapsed(sec)
          if (sec >= MAX_RECORDING_SEC) {
            void finish(true).then((file) => file && autoStopRef.current?.(file))
            return
          }
        }
        s.raf = requestAnimationFrame(tick)
      }
      recorder.start(1000)
      s.raf = requestAnimationFrame(tick)
      setStatus('recording')
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      session.current = null
      setError('failed')
      setStatus('error')
    }
  }, [finish])

  /** Asks for the mic and starts recording (no-op while already starting / recording). */
  const start = useCallback(async () => {
    if (session.current || starting.current) return
    starting.current = true
    try {
      await begin()
    } finally {
      starting.current = false
    }
  }, [begin])

  /** Stops and returns the recorded file (null if nothing was captured). */
  const stop = useCallback(() => finish(true), [finish])

  /** Stops and discards the recording. */
  const cancel = useCallback(() => {
    void finish(false)
    setError(null)
    setStatus('idle')
  }, [finish])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      teardown()
    }
  }, [teardown])

  return { status, error, elapsed, levels, start, stop, cancel }
}
