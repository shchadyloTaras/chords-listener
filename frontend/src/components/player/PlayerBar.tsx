import { useLayoutEffect, useRef } from 'react'
import { useT } from '../../i18n'
import type { Track } from '../../types'
import { LoopChip, PlayButton, SkipButton, SpeedMenu, TimeReadout, VideoToggle, VolumeControl } from './PlayerControls'
import { trackVideoId } from './trackSource'
import { SeekBar } from './SeekBar'
import { PlayAlongToggle } from '../chords/PlayAlong'
import { MetronomeToggle } from '../chords/tempo/MetronomeToggle'

/**
 * Sticky bottom transport. Desktop: one row. Phones: waveform row on top,
 * then speed · transport · volume/video with the play button centered.
 * Publishes its height as --player-h so toasts / floating video sit above it.
 */
export function PlayerBar({ track }: { track: Track }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const videoId = trackVideoId(track)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement.style
    const apply = () => root.setProperty('--player-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.removeProperty('--player-h')
    }
  }, [])

  return (
    <div
      ref={ref}
      role="region"
      aria-label={t('core.player.region')}
      data-tour="song.player"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-1 gap-y-0.5 px-3 pt-1.5 pb-2 sm:flex-nowrap sm:gap-x-2 sm:px-5 sm:py-2.5">
        <div className="order-1 flex w-full min-w-0 items-center gap-2.5 sm:order-2 sm:w-auto sm:flex-1 sm:gap-3">
          <TimeReadout which="current" track={track} />
          <SeekBar track={track} />
          <TimeReadout which="duration" track={track} />
        </div>
        <div className="order-2 flex flex-1 items-center gap-1 sm:order-3 sm:flex-none">
          <LoopChip />
          <SpeedMenu />
          <MetronomeToggle />
          <PlayAlongToggle />
        </div>
        <div className="order-3 flex items-center gap-1 sm:order-1 sm:gap-1.5">
          <SkipButton dir={-1} />
          <PlayButton />
          <SkipButton dir={1} />
        </div>
        <div className="order-4 flex flex-1 items-center justify-end gap-1 sm:flex-none">
          <VolumeControl />
          {videoId && <VideoToggle trackId={track.id} />}
        </div>
      </div>
    </div>
  )
}
