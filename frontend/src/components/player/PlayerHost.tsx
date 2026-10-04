import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { PlaybackEngine } from './engine'
import { usePlayerUi } from './playerUi'
import { trackVideoId } from './trackSource'
import { VideoPanel } from './VideoPanel'

/**
 * Mounts the playback engine for the loaded track (audio, or a silent clock for the demo)
 * and the optional YouTube video panel. Renders nothing else.
 */
export function PlayerHost({ track }: { track: Track }) {
  const [engine, setEngine] = useState<PlaybackEngine | null>(null)
  const trackRef = useRef(track)
  useEffect(() => {
    trackRef.current = track
  })

  // Recreate only when the media changes — not on title / chord edits.
  useEffect(() => {
    const e = new PlaybackEngine(trackRef.current)
    setEngine(e)
    return () => {
      e.destroy()
      setEngine(null)
    }
  }, [track.id, track.audioUrl])

  const videoId = trackVideoId(track)
  const showVideo = useApp((s) => s.showVideo)
  const blocked = usePlayerUi((s) => Boolean(s.blocked[track.id]))

  if (!engine || !videoId || !showVideo || blocked) return null
  return <VideoPanel key={`${track.id}:${videoId}`} engine={engine} videoId={videoId} trackId={track.id} />
}
