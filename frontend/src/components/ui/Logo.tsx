import clsx from 'clsx'

/**
 * Brand mark: four bars colored like Am – F – C – G on the circle of fifths
 * (the same hues the chord UI uses), reading as a tiny waveform.
 */
export function LogoMark({ className }: { className?: string }) {
  const bars: Array<[number, number, string]> = [
    [4, 10, 'var(--chord-3)'],
    [10.5, 16, 'var(--chord-11)'],
    [17, 7, 'var(--chord-0)'],
    [23.5, 12, 'var(--chord-1)'],
  ]
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={clsx('shrink-0', className)}>
      <rect width="32" height="32" rx="9" fill="var(--surface-3)" />
      {bars.map(([x, h, color]) => (
        <rect key={x} x={x} y={16 - h / 2 - 1} width="4.5" height={h + 2} rx="2.25" fill={color} />
      ))}
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('font-display font-semibold tracking-tight', className)}>
      Chords<span className="text-muted"> Listener</span>
    </span>
  )
}

/** Small neutral "video platform" glyph (rounded screen + play triangle). */
export function VideoSiteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={clsx('shrink-0', className)} fill="currentColor">
      <path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" />
    </svg>
  )
}
