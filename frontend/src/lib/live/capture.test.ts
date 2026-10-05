import { afterEach, describe, expect, it, vi } from 'vitest'
import { canCaptureTab, canListenInTab, captureMicrophone, captureTabAudio, isMobileDevice, toCaptureError } from './capture.ts'
import { pickRecordingMime } from './recorder.ts'
import { startLiveSession } from './session.ts'
import { CaptureError } from './types.ts'

class FakeTrack {
  readonly kind: 'audio' | 'video'
  stopped = false
  constructor(kind: 'audio' | 'video') {
    this.kind = kind
  }
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks.slice()
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t)
  }
}

function domError(name: string): Error {
  const e = new Error(`${name} happened`)
  e.name = name
  return e
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'

interface FakeNavigatorOptions {
  ua?: string
  touch?: number
  mobile?: boolean
  brands?: string[]
  supported?: Record<string, boolean>
  getUserMedia?: (c: MediaStreamConstraints) => Promise<unknown>
  getDisplayMedia?: ((c: unknown) => Promise<unknown>) | null
}

function stubBrowser(o: FakeNavigatorOptions = {}, secure = true) {
  const mediaDevices: Record<string, unknown> = {
    getSupportedConstraints: () => o.supported ?? {},
  }
  if (o.getUserMedia) mediaDevices.getUserMedia = o.getUserMedia
  if (o.getDisplayMedia !== null) mediaDevices.getDisplayMedia = o.getDisplayMedia ?? (() => Promise.reject(domError('NotAllowedError')))
  vi.stubGlobal('navigator', {
    userAgent: o.ua ?? CHROME_UA,
    maxTouchPoints: o.touch ?? 0,
    userAgentData: o.brands || o.mobile !== undefined ? { mobile: !!o.mobile, brands: (o.brands ?? []).map((brand) => ({ brand })) } : undefined,
    mediaDevices,
  })
  vi.stubGlobal('window', { isSecureContext: secure })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureMicrophone', () => {
  it('asks for raw music audio (no echo cancellation, noise suppression or AGC)', async () => {
    const stream = new FakeStream([new FakeTrack('audio')])
    const getUserMedia = vi.fn(async () => stream)
    stubBrowser({ getUserMedia })
    expect(await captureMicrophone()).toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    })
  })

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'blocked'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'failed'],
    ['AbortError', 'failed'],
    ['TypeError', 'unsupported'],
  ])('maps %s to CaptureError(%s)', async (name, code) => {
    stubBrowser({ getUserMedia: () => Promise.reject(domError(name)) })
    await expect(captureMicrophone()).rejects.toMatchObject({ name: 'CaptureError', code })
  })

  it('needs a secure context and getUserMedia', async () => {
    stubBrowser({ getUserMedia: async () => new FakeStream([]) }, false)
    await expect(captureMicrophone()).rejects.toMatchObject({ code: 'insecure' })
    stubBrowser({})
    await expect(captureMicrophone()).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('captureTabAudio', () => {
  it('requests this tab with its audio and returns an audio-only stream', async () => {
    const video = new FakeTrack('video')
    const audio = new FakeTrack('audio')
    const getDisplayMedia = vi.fn(async () => new FakeStream([video, audio]))
    stubBrowser({ getDisplayMedia, supported: { suppressLocalAudioPlayback: true } })
    const stream = (await captureTabAudio()) as unknown as FakeStream
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
      monitorTypeSurfaces: 'exclude',
    })
    expect(video.stopped).toBe(true)
    expect(stream.getVideoTracks()).toEqual([])
    expect(stream.getAudioTracks()).toEqual([audio])
    expect(audio.stopped).toBe(false)
  })

  it('throws no-audio (and stops the capture) when tab audio was not shared', async () => {
    const video = new FakeTrack('video')
    stubBrowser({ getDisplayMedia: async () => new FakeStream([video]) })
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'no-audio' })
    expect(video.stopped).toBe(true)
  })

  it('maps a cancelled picker to denied, and phones / missing API to unsupported', async () => {
    stubBrowser({ getDisplayMedia: () => Promise.reject(domError('NotAllowedError')) })
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'denied' })
    stubBrowser({ getDisplayMedia: null })
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'unsupported' })
    stubBrowser({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36', getDisplayMedia: async () => new FakeStream([]) })
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'unsupported' })
    stubBrowser({ getDisplayMedia: async () => new FakeStream([]) }, false)
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'insecure' })
  })
})

describe('canCaptureTab', () => {
  it('is true on desktop Chromium', () => {
    stubBrowser({ supported: { suppressLocalAudioPlayback: true } })
    expect(canCaptureTab()).toBe(true)
    stubBrowser({ brands: ['Chromium', 'Google Chrome'] })
    expect(canCaptureTab()).toBe(true)
  })

  it('is false on phones and tablets', () => {
    stubBrowser({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', supported: { suppressLocalAudioPlayback: true } })
    expect(canCaptureTab()).toBe(false)
    stubBrowser({ ua: SAFARI_UA, touch: 5 }) // iPadOS asks for the desktop site
    expect(isMobileDevice()).toBe(true)
    expect(canCaptureTab()).toBe(false)
    stubBrowser({ mobile: true, brands: ['Chromium'], supported: { suppressLocalAudioPlayback: true } })
    expect(canCaptureTab()).toBe(false)
  })

  it('is false where tab audio cannot be shared (no getDisplayMedia, desktop Safari / Firefox)', () => {
    stubBrowser({ getDisplayMedia: null, supported: { suppressLocalAudioPlayback: true } })
    expect(canCaptureTab()).toBe(false)
    stubBrowser({ ua: SAFARI_UA })
    expect(canCaptureTab()).toBe(false)
  })
})

describe('canListenInTab', () => {
  const touchOnly = (matches: boolean) =>
    vi.stubGlobal('window', { isSecureContext: true, matchMedia: (q: string) => ({ matches: matches && q === '(hover: none) and (pointer: coarse)' }) })

  it('is true where the tab can be captured on a device with a mouse', () => {
    stubBrowser({ supported: { suppressLocalAudioPlayback: true } })
    expect(canListenInTab()).toBe(true) // no matchMedia: decided by canCaptureTab
    touchOnly(false)
    expect(canListenInTab()).toBe(true)
  })

  it('is false on a touch-only device, even with a desktop user agent', () => {
    stubBrowser({ supported: { suppressLocalAudioPlayback: true } })
    touchOnly(true)
    expect(canListenInTab()).toBe(false)
  })

  it('is false where tab capture is unsupported', () => {
    stubBrowser({ ua: SAFARI_UA })
    touchOnly(false)
    expect(canListenInTab()).toBe(false)
  })
})

describe('helpers', () => {
  it('toCaptureError keeps CaptureErrors and tells mic from tab', () => {
    const e = new CaptureError('no-audio')
    expect(toCaptureError(e, 'tab')).toBe(e)
    expect(toCaptureError(domError('NotFoundError'), 'mic').code).toBe('no-device')
    expect(toCaptureError(domError('NotFoundError'), 'tab').code).toBe('failed')
    expect(toCaptureError('weird', 'mic').code).toBe('failed')
  })

  it.each([
    [{ name: 'NotAllowedError', message: 'Permission denied' }, 'tab', 'denied'],
    [{ name: 'NotAllowedError', message: 'Permission denied by system' }, 'tab', 'blocked'],
    [{ name: 'SecurityError', message: 'Access to the feature "display-capture" is disallowed by permission policy.' }, 'tab', 'blocked'],
    [{ name: 'NotAllowedError', message: 'Permission dismissed' }, 'mic', 'denied'],
  ])('maps %o (%s) to %s and keeps the browser\'s message', (err, source, code) => {
    const e = Object.assign(new Error(err.message), { name: err.name })
    const mapped = toCaptureError(e, source as 'tab' | 'mic')
    expect(mapped.code).toBe(code)
    expect(mapped.message).toContain(err.message)
  })

  it('picks webm/opus, or mp4 where only that records (Safari)', () => {
    expect(pickRecordingMime((m) => m.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
    expect(pickRecordingMime((m) => m.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(pickRecordingMime(() => false)).toBe('')
  })
})

describe('startLiveSession (start errors)', () => {
  it('rejects streams without audio and stops their tracks', async () => {
    const video = new FakeTrack('video')
    await expect(startLiveSession(new FakeStream([video]) as unknown as MediaStream)).rejects.toMatchObject({ code: 'no-audio' })
    expect(video.stopped).toBe(true)
  })

  it('rejects as unsupported without Web Audio, keeping the tracks when asked', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const audio = new FakeTrack('audio')
    await expect(startLiveSession(new FakeStream([audio]) as unknown as MediaStream, { keepTracks: true })).rejects.toMatchObject({ code: 'unsupported' })
    expect(audio.stopped).toBe(false)
  })
})
