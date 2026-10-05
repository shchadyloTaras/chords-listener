import { useEffect, useRef, useState } from 'react'
import { cloudCacheUid } from '../../lib/api'
import { isLocalId } from '../../lib/local'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { cloudPlayback, type CloudPlayback } from './cloudAudio'
import { PlaybackEngine } from './engine'
import type { AudioMedia } from './sources/audioSource'
import { usePlayerUi } from './playerUi'
import { trackVideoId } from './trackSource'
import { VideoPanel } from './VideoPanel'

/**
 * Mounts the playback engine for the loaded track (audio, or a silent clock for the demo)
 * and the optional YouTube video panel. Renders nothing else. A cloud track plays from the copy
 * kept on this device when there is one (components/player/cloudAudio).
 */
export function PlayerHost({ track }: { track: Track }) {
  const [engine, setEngine] = useState<PlaybackEngine | null>(null)
  const trackRef = useRef(track)
  useEffect(() => {
    trackRef.current = track
  })

  // Recreate only when the media changes — not on title / chord edits.
  useEffect(() => {
    let e: PlaybackEngine | null = null
    let release: (() => void) | undefined
    let stopped = false
    const start = (tr: Track, media?: AudioMedia) => {
      e = new PlaybackEngine(tr, media)
      setEngine(e)
    }
    const current = trackRef.current
    const uid = cloudCacheUid()
    if (!uid || isLocalId(current.id) || !current.audioUrl) start(current)
    else
      void cloudPlayback(uid, current)
        // whatever happens on the device, the track plays (from its URL)
        .catch((): CloudPlayback => ({ track: current, media: {} }))
        .then((p) => {
          if (stopped) return p.release?.()
          release = p.release
          start(p.track, p.media)
        })
    return () => {
      stopped = true
      e?.destroy()
      setEngine(null)
      release?.()
    }
  }, [track.id, track.audioUrl])

  const videoId = trackVideoId(track)
  const showVideo = useApp((s) => s.showVideo)
  const blocked = usePlayerUi((s) => Boolean(s.blocked[track.id]))

  if (!engine || !videoId || !showVideo || blocked) return null
  return <VideoPanel key={`${track.id}:${videoId}`} engine={engine} videoId={videoId} trackId={track.id} />
}
