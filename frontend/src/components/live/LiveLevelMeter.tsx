import { memo } from 'react'
import clsx from 'clsx'
import { useT } from '../../i18n'

/**
 * Small segmented input-level meter (studio style): `level` 0..1 as from LiveUpdate.level
 * (-60..0 dBFS). Low segments use the success colour, then the accent, the top one warns of
 * clipping. Segments fade rather than jump, so ~10 updates per second look smooth.
 */
export const LiveLevelMeter = memo(function LiveLevelMeter({
  level,
  active = true,
  segments = 12,
  className,
  size = 'md',
}: {
  level: number
  /** dimmed while paused / stopped */
  active?: boolean
  segments?: number
  className?: string
  size?: 'sm' | 'md'
}) {
  const t = useT()
  const v = active && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
  const lit = Math.round(v * segments)
  return (
    <div
      role="meter"
      aria-label={t('live.level')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={clsx('flex shrink-0 items-end gap-[3px]', size === 'sm' ? 'h-3.5' : 'h-5', !active && 'opacity-50', className)}
    >
      {Array.from({ length: segments }, (_, i) => {
        const at = (i + 1) / segments
        const color = at > 0.92 ? 'var(--danger)' : at > 0.7 ? 'var(--accent)' : 'var(--success)'
        return (
          <span
            key={i}
            aria-hidden
            className={clsx('rounded-[2px] transition-[opacity,background-color] duration-100 ease-out', size === 'sm' ? 'w-[3px]' : 'w-1')}
            style={{
              height: `${40 + 60 * (i / Math.max(1, segments - 1))}%`,
              backgroundColor: i < lit ? color : 'var(--border-strong)',
              opacity: i < lit ? 1 : 0.55,
            }}
          />
        )
      })}
    </div>
  )
})
