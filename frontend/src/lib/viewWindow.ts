// The stretch of the time axis a track is played and shown over. Times stay track time, but a fragment of a
// YouTube video (`clip`, docs/CLOUD.md → YouTube clips) covers only clip.start..clip.end and a recording linked
// to a video (`startOffset`) only startOffset..duration: the seek bar, the timeline, the bars and the time
// readouts show that stretch, not 0..duration (where 30 s of a long video would be a sliver at the very end).
import type { Track } from '../types'

export interface ViewWindow {
  start: number
  end: number
}

/** `liveDuration`: the player's own duration once it knows it (0 = not yet; the track's is used then). */
export function viewWindow(track: Pick<Track, 'duration' | 'clip' | 'startOffset'>, liveDuration = 0): ViewWindow {
  const duration = liveDuration > 0 ? liveDuration : track.duration
  const end = track.clip ? Math.min(track.clip.end, duration > 0 ? duration : track.clip.end) : duration
  if (!(Number.isFinite(end) && end > 0)) return { start: 0, end: 0 }
  const start = track.clip?.start ?? track.startOffset ?? 0
  return { start: Number.isFinite(start) && start > 0 && start < end ? start : 0, end }
}

/** The peaks of `waveform` (spread evenly over 0..duration) inside the window; the same array for the whole track. */
export function sliceWaveform(waveform: readonly number[], duration: number, window: ViewWindow): readonly number[] {
  const n = waveform.length
  if (!n || !(duration > 0) || (window.start <= 0 && window.end >= duration)) return waveform
  const from = Math.min(n - 1, Math.max(0, Math.floor((window.start / duration) * n)))
  const to = Math.min(n, Math.max(from + 1, Math.ceil((window.end / duration) * n)))
  return waveform.slice(from, to)
}

/** Where `time` sits in the window, 0..100 % (clamped). */
export function windowPct(time: number, window: ViewWindow): number {
  const len = window.end - window.start
  return len > 0 ? Math.min(100, Math.max(0, ((time - window.start) / len) * 100)) : 0
}

/** The part of from..to inside the window, in % of the window; null when none of it is inside. */
export function windowSpan(from: number, to: number, window: ViewWindow): { left: number; width: number } | null {
  const a = Math.max(from, window.start)
  const b = Math.min(to, window.end)
  if (!(b > a) || !(window.end > window.start)) return null
  const left = windowPct(a, window)
  return { left, width: windowPct(b, window) - left }
}
