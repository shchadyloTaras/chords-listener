import { fetchTrackAudio } from '../../lib/api'
import { cachedAudio, forgetTrack } from '../../lib/cloud/cache'
import type { Track } from '../../types'
import type { AudioMedia } from './sources/audioSource'

export interface CloudPlayback {
  /** the track to play: its `audioUrl` is the copy on this device when there is one */
  track: Track
  media: AudioMedia
  /** frees the copy's object URL once the player is done with it */
  release?: () => void
}

/**
 * How a cloud track plays (lib/cloud/cache): from the copy kept on this device — no request — or else from its
 * signed URL, and once the browser can play that through, the file is downloaded once in the background
 * (fetchTrackAudio keeps it) for next time.
 */
export async function cloudPlayback(uid: string, track: Track): Promise<CloudPlayback> {
  const blob = await cachedAudio(uid, track.id)
  if (blob) {
    const url = URL.createObjectURL(blob)
    return {
      track: { ...track, audioUrl: url },
      release: () => URL.revokeObjectURL(url),
      media: {
        // the copy does not play (damaged, or its file evicted by the browser): drop it, stream the signed URL
        recover: async () => {
          await forgetTrack(uid, track.id, ['audio'])
          return track.audioUrl
        },
      },
    }
  }
  return {
    track,
    media: {
      onReady: () => void fetchTrackAudio(track).catch(() => undefined),
      // the signed URL does not play (it ran out, or the browser refuses to stream it): the whole file, with a
      // fresh URL if the cloud asks for one
      recover: async () => URL.createObjectURL(await fetchTrackAudio(track)),
    },
  }
}
