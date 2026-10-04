import clsx from 'clsx'
import { useState } from 'react'
import type { KeyInfo, TrackSource } from '../../types'
import { fifthsIndex } from '../ui/chordColor'
import { hashString } from '../ui/format'

interface TrackCoverProps {
  title: string
  thumbnail?: string | null
  keyInfo?: KeyInfo | null
  source?: TrackSource | null
  className?: string
}

/**
 * Thumbnail, or a generated cover: tinted with the song key's circle-of-fifths color
 * (same palette as the chord blocks), showing the key name or the title's initial.
 */
export function TrackCover({ title, thumbnail, keyInfo, className }: TrackCoverProps) {
  const [failed, setFailed] = useState(false)
  if (thumbnail && !failed) {
    return (
      <img
        src={thumbnail}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={clsx('shrink-0 bg-surface-3 object-cover', className)}
      />
    )
  }
  const idx = fifthsIndex(keyInfo?.tonic) ?? hashString(title) % 12
  const color = `var(--chord-${idx})`
  const label = keyInfo?.name || (title.trim()[0] ?? '♪').toUpperCase()
  return (
    <div
      aria-hidden="true"
      className={clsx('relative flex shrink-0 items-center justify-center overflow-hidden', className)}
      style={{ background: `color-mix(in oklab, ${color} 22%, var(--surface-2))`, color }}
    >
      <span className="font-display text-lg leading-none font-bold tracking-tight">{label}</span>
    </div>
  )
}
