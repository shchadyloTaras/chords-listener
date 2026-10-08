// A fragment track (`track.clip`, docs/CLOUD.md → YouTube clips): the YouTube player would run on past the fragment,
// so playback stops at `clip.end`, and play from there starts the fragment again. Pure; engine.ts applies it.
import type { ClipRange } from '../../types'

/** This close to the end counts as "at the end". */
export const CLIP_END_SLACK_S = 0.25

/** Where play() first seeks: the fragment's start when the playhead is at / after its end; null otherwise. */
export function clipRestart(time: number, clip: ClipRange | null | undefined): number | null {
  return clip && time >= clip.end - CLIP_END_SLACK_S ? clip.start : null
}

/** The playhead ran past the fragment's end (a set A–B loop decides instead). */
export function pastClipEnd(
  time: number,
  clip: ClipRange | null | undefined,
  loop: { start: number; end: number } | null,
): boolean {
  if (!clip || (loop && loop.end > loop.start)) return false
  return time >= clip.end
}
