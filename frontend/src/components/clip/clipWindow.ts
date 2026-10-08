// The fragment window of the YouTube picker (#/youtube/<videoId>): whole seconds, inside the video, CLIP_SECONDS
// long (a video shorter than that is taken whole). Pure; ClipPage / ClipTimeline do the DOM.
import type { ClipRange } from '../../types'

/** Length of a fragment the cloud analyzes, s: the server's CHORDS_YT_CLIP_S (keep the two equal). */
export const CLIP_SECONDS = 30

// the server's limit for a fragment start (POST /api/jobs clip.start ≤ 86400)
export const MAX_CLIP_START_S = 24 * 3600

/** The latest start that still fits the video (0 when it is shorter than the window); Infinity while unknown. */
export function maxStart(duration: number | null, length = CLIP_SECONDS): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(duration - length))
}

/** A start in whole seconds, inside the video. */
export function clampStart(start: number, duration: number | null, length = CLIP_SECONDS): number {
  const s = Number.isFinite(start) ? Math.floor(Math.max(0, start)) : 0
  return Math.min(s, maxStart(duration, length), MAX_CLIP_START_S)
}

/** The window that starts at `start` (clamped); it ends at the video's end when that comes first. */
export function clipWindow(start: number, duration: number | null, length = CLIP_SECONDS): ClipRange {
  const s = clampStart(start, duration, length)
  const known = duration !== null && Number.isFinite(duration) && duration > 0
  return { start: s, end: known ? Math.min(s + length, Math.floor(duration)) : s + length }
}

/** ←/→ move the window by 1 s, with Shift by 5 s. */
export function nudgeStart(start: number, delta: number, duration: number | null, length = CLIP_SECONDS): number {
  return clampStart(start + delta, duration, length)
}

/** «Звідси»: the window begins where the video is now. */
export function startAt(time: number, duration: number | null, length = CLIP_SECONDS): number {
  return clampStart(time, duration, length)
}

/** A tap at `fraction` (0..1) of the timeline: the window is centred on that point of the video. */
export function startFromTap(fraction: number, duration: number, length = CLIP_SECONDS): number {
  return clampStart(fraction * duration - length / 2, duration, length)
}

/** Dragging the window: its start (`origin` when the drag began) follows `dx` px of a `width` px timeline. */
export function startFromDrag(origin: number, dx: number, width: number, duration: number, length = CLIP_SECONDS): number {
  if (width <= 0 || duration <= 0) return clampStart(origin, duration, length)
  return clampStart(origin + (dx / width) * duration, duration, length)
}
