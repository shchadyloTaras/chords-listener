// Turns what a listening session recorded into a track: the cloud analyzes it when the user is signed in
// (Firebase Storage + POST /api/jobs/storage), otherwise the browser does (IndexedDB). A recording of a
// YouTube video keeps its link and lines up with the video.
import { t } from '../../i18n'
import type { Job, TrackSource } from '../../types'
import { useConnection } from '../../lib/serverMode'
import { mediaFilename } from '../../lib/cloud/storage'
import { uploadAndFollow } from '../../hooks/useJobs'
import { padAudioStart } from './padAudio'

export interface VideoLink {
  videoId: string
  url: string
  /** video time (s) the recording began at */
  startOffset: number
}

/** Offsets below this are treated as "from the beginning" (no padding, no shifting). */
const MIN_OFFSET_S = 0.25

/** "Запис 2026-10-04 21-37" (the same naming as microphone recordings). */
export function recordingTitle(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`
  return `${t('core.rec.fileTitle')} ${stamp}`
}

/** File name for a recording title. */
export function recordingFilename(title: string, mime: string): string {
  return mediaFilename(title, mime)
}

export function youtubeSource(link: VideoLink): TrackSource {
  return { type: 'youtube', videoId: link.videoId, url: link.url, filename: null }
}

/**
 * Uploads / analyzes a recording and follows its job (the page moves to the job). Throws ApiError (or a
 * decoding error while padding in browser mode).
 */
export async function saveRecording(audio: Blob, mime: string, opts: { title: string; video?: VideoLink; signal?: AbortSignal }): Promise<Job> {
  const type = (mime || audio.type || 'audio/webm').split(';')[0]
  const { title, video, signal } = opts
  if (!video) {
    const file = new File([audio], recordingFilename(title, type), { type })
    return uploadAndFollow(file, undefined, { meta: { title, origin: 'mic' }, signal })
  }
  const source = youtubeSource(video)
  const offset = video.startOffset >= MIN_OFFSET_S ? video.startOffset : 0
  if (useConnection.getState().backend === 'cloud') {
    const file = new File([audio], recordingFilename(title, type), { type })
    return uploadAndFollow(file, undefined, { meta: { title, source, startOffset: offset }, signal })
  }
  // browser (also next to the user's own server, which knows nothing about video links): the stored audio
  // starts at the video's 0:00, so it lines up with the video and the player as it is
  const padded = offset > 0 ? await padAudioStart(audio, offset) : audio
  const paddedType = offset > 0 ? 'audio/wav' : type
  const file = new File([padded], recordingFilename(title, paddedType), { type: paddedType })
  return uploadAndFollow(file, undefined, { meta: { title, source }, inBrowser: true, signal })
}
