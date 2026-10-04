// Live beat indicator: one dot per beat of the bar, the downbeat bigger and amber. The dot of the
// current beat lights up exactly when the player clock crosses that beat and pulses briefly
// (no pulse with prefers-reduced-motion). Driven per frame without React re-renders.

import { useRef } from 'react'
import clsx from 'clsx'
import { useReducedMotion } from 'framer-motion'
import { beatIndexAt, type PulseGrid } from '../../../lib/tempo'
import { useApp } from '../../../store'
import { useClockEffect } from '../clock'
import './tempo.css'

/** Real-time decay of the pulse after each beat (s). */
const DECAY = 0.11
/** Max extra scale on the beat. */
const SWELL = 0.6

export function BeatPulse({ grid, small, className }: { grid: PulseGrid; small?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduce = useReducedMotion()
  const isPlaying = useApp((s) => s.isPlaying)
  const rate = useApp((s) => s.playbackRate)

  useClockEffect(
    (time) => {
      const el = ref.current
      if (!el) return
      // A frame that lands a hair before the beat still counts as the beat (≈ half a frame).
      const i = beatIndexAt(grid.times, time + 0.008)
      const active = i >= 0 ? grid.pos[i] : -1
      const age = i >= 0 ? Math.max(0, time - grid.times[i]) / (rate > 0 ? rate : 1) : Infinity
      const k = isPlaying && !reduce ? Math.exp(-age / DECAY) : 0
      const dots = el.children
      for (let d = 0; d < dots.length; d++) {
        const dot = dots[d] as HTMLElement
        const on = d === active
        const s = on ? 'on' : 'off'
        if (dot.dataset.s !== s) dot.dataset.s = s
        const transform = on && k > 0.02 ? `scale(${(1 + SWELL * k).toFixed(3)})` : ''
        if (dot.style.transform !== transform) dot.style.transform = transform
      }
    },
    [grid, isPlaying, reduce, rate],
  )

  return (
    <span ref={ref} aria-hidden className={clsx('flex items-center', small ? 'tp-pulse-sm gap-1' : 'gap-1.5', className)}>
      {Array.from({ length: grid.meter }, (_, d) => (
        <span key={d} className="tp-dot" data-s="off" data-down={d === 0 ? '' : undefined} />
      ))}
    </span>
  )
}
