// Getting a MediaStream to listen to: the microphone, or this browser tab's own audio
// (getDisplayMedia; desktop Chromium only — the YouTube embed on the page plays into it).

import { CaptureError, type CaptureErrorCode } from './types.ts'

/** Chromium-only getDisplayMedia() options (not in the DOM lib yet). */
interface DisplayMediaOptions extends DisplayMediaStreamOptions {
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
}

interface NavigatorUAData {
  mobile?: boolean
  brands?: { brand: string }[]
}

function nav(): (Navigator & { userAgentData?: NavigatorUAData }) | null {
  return typeof navigator === 'undefined' ? null : navigator
}

/** Phones and tablets (no tab capture there; iPadOS reports a desktop Safari UA). */
export function isMobileDevice(): boolean {
  const n = nav()
  if (!n) return false
  if (n.userAgentData?.mobile) return true
  const ua = n.userAgent || ''
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini/i.test(ua)) return true
  return /Macintosh/.test(ua) && (n.maxTouchPoints ?? 0) > 1
}

/**
 * Is capturing this tab's audio supported here (desktop Chrome / Edge / other Chromium)?
 * Feature detection: getDisplayMedia plus the tab-audio constraint `suppressLocalAudioPlayback`,
 * which only Chromium (which is also the only engine that shares tab audio) supports; false on
 * phones and tablets.
 */
export function canCaptureTab(): boolean {
  const n = nav()
  if (!n?.mediaDevices?.getDisplayMedia || isMobileDevice()) return false
  if (typeof window !== 'undefined' && window.isSecureContext === false) return false
  try {
    const supported = n.mediaDevices.getSupportedConstraints?.() as Record<string, boolean> | undefined
    if (supported?.suppressLocalAudioPlayback) return true
  } catch {
    /* fall through to the brand check */
  }
  return !!n.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand))
}

/** Can the microphone be requested here (it may still be denied)? */
export function canCaptureMicrophone(): boolean {
  return !!nav()?.mediaDevices?.getUserMedia
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) return String((err as { name: unknown }).name)
  return ''
}

/** Map a getUserMedia / getDisplayMedia rejection to a CaptureError. */
export function toCaptureError(err: unknown, source: 'mic' | 'tab'): CaptureError {
  if (err instanceof CaptureError) return err
  const name = errorName(err)
  const detail = err instanceof Error && err.message ? err.message : name || String(err)
  let code: CaptureErrorCode
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      code = 'denied'
      break
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      code = source === 'mic' ? 'no-device' : 'failed'
      break
    case 'NotSupportedError':
    case 'TypeError':
      code = 'unsupported'
      break
    default:
      // NotReadableError (device busy), AbortError, InvalidStateError (no user gesture), …
      code = 'failed'
  }
  return new CaptureError(code, detail)
}

function checkContext(): void {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new CaptureError('insecure', 'capturing audio needs a secure context (https or localhost)')
  }
}

/** Microphone stream (with echo cancellation etc. disabled for music). */
export async function captureMicrophone(): Promise<MediaStream> {
  checkContext()
  const media = nav()?.mediaDevices
  if (!media?.getUserMedia) throw new CaptureError('unsupported', 'this browser cannot record from a microphone')
  try {
    return await media.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    })
  } catch (err) {
    throw toCaptureError(err, 'mic')
  }
}

/** Asks the user to share THIS tab with its audio; returns an audio-only stream. */
export async function captureTabAudio(): Promise<MediaStream> {
  checkContext()
  const media = nav()?.mediaDevices
  if (!media?.getDisplayMedia || isMobileDevice()) {
    throw new CaptureError('unsupported', 'this browser cannot share a tab’s audio')
  }
  const options: DisplayMediaOptions = {
    // Chrome requires video; it is dropped right away
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    } as MediaTrackConstraints,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
    monitorTypeSurfaces: 'exclude',
  }
  let stream: MediaStream
  try {
    stream = await media.getDisplayMedia(options)
  } catch (err) {
    throw toCaptureError(err, 'tab')
  }
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  const audio = stream.getAudioTracks()
  if (!audio.length) {
    stream.getTracks().forEach((t) => t.stop())
    throw new CaptureError('no-audio', 'the shared tab has no audio (turn on “Also share tab audio”)')
  }
  return stream
}
