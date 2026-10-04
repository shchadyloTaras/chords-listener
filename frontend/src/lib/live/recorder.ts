// Recording what the session hears (MediaRecorder): webm/opus where supported, mp4/AAC on Safari.

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

/** The first recording format this browser supports ('' = let the browser choose). */
export function pickRecordingMime(isSupported: (mime: string) => boolean = defaultSupport): string {
  return MIME_CANDIDATES.find((m) => isSupported(m)) ?? ''
}

function defaultSupport(mime: string): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mime)
}

export interface Recording {
  readonly mimeType: string
  /** starts recording (or continues a paused recording) */
  resume(): void
  pause(): void
  /** stop and collect the audio (null when nothing was recorded) */
  stop(): Promise<Blob | null>
}

/**
 * A recorder for the stream's audio tracks, recording at once unless `paused` (then the first
 * resume() starts it); null when MediaRecorder is unavailable or refuses the stream.
 */
export function createRecording(stream: MediaStream, audioBitsPerSecond = 128_000, paused = false): Recording | null {
  if (typeof MediaRecorder === 'undefined') return null
  const audioOnly = new MediaStream(stream.getAudioTracks())
  const preferred = pickRecordingMime()
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(audioOnly, preferred ? { mimeType: preferred, audioBitsPerSecond } : { audioBitsPerSecond })
  } catch {
    try {
      recorder = new MediaRecorder(audioOnly)
    } catch {
      return null
    }
  }
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  let started = false
  let failed = false
  const start = () => {
    if (started || failed) return
    try {
      // 1 s slices: the data survives a crashed tab better and stop() has little left to flush
      recorder.start(1000)
      started = true
    } catch {
      failed = true
    }
  }
  if (!paused) {
    start()
    if (failed) return null
  }
  let stopping: Promise<Blob | null> | null = null
  const mime = () => recorder.mimeType || preferred || chunks[0]?.type || ''
  return {
    get mimeType() {
      return mime()
    },
    pause() {
      if (recorder.state === 'recording') recorder.pause()
    },
    resume() {
      if (!started) start()
      else if (recorder.state === 'paused') recorder.resume()
    },
    stop() {
      if (stopping) return stopping
      stopping = new Promise<Blob | null>((resolve) => {
        const done = () => {
          clearTimeout(timeout)
          resolve(chunks.length ? new Blob(chunks, { type: mime() }) : null)
        }
        // a recorder whose tracks ended may never fire 'stop' again
        const timeout = setTimeout(done, 3000)
        if (recorder.state === 'inactive') {
          done()
          return
        }
        recorder.addEventListener('stop', done, { once: true })
        try {
          recorder.stop()
        } catch {
          done()
        }
      })
      return stopping
    },
  }
}
