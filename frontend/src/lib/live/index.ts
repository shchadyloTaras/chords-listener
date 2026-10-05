// Live listening: real-time chord recognition from a MediaStream (microphone or captured tab
// audio) plus recording of what was heard.
//
//   const stream = await captureTabAudio()          // or captureMicrophone()
//   const session = await startLiveSession(stream)  // { record: true } by default
//   const off = session.onUpdate((u) => render(u.current, u.history, u.level, u.key, u.tempo))
//   session.pause(); session.resume()               // e.g. with the YouTube player
//   const { audio, mimeType, duration, chords } = await session.stop()
//
// Pipeline: AudioWorklet (mono PCM, audio thread) -> module Worker (resample to 22.05 kHz,
// the offline engine's chroma features computed incrementally, online HMM with forward
// filtering + fixed-lag smoothing over the engine's chord vocabulary) -> updates to the main
// thread at <= 10 Hz. A new chord shows ~0.7 s after it starts (provisional), and its label is
// final ~1.2 s after it starts. Everything is cleaned up on stop() or a failed start.

export type {
  CaptureErrorCode, LiveChord, LiveOptions, LiveResult, LiveSession, LiveSessionState, LiveStats, LiveUpdate,
} from './types.ts'
export { CaptureError } from './types.ts'
export {
  canCaptureMicrophone, canCaptureTab, canListenInTab, captureMicrophone, captureTabAudio, isMobileDevice, TOUCH_ONLY_QUERY,
} from './capture.ts'
export { isLiveSupported, startLiveSession } from './session.ts'
