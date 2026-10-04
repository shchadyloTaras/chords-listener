// Tiny tempo-over-time chart with the playhead. Dashed line = overall tempo.

import { useId, useMemo, useRef } from 'react'
import { useT } from '../../../i18n'
import { tempoCurve } from '../../../lib/tempo'
import { useClockEffect } from '../clock'

const W = 300
const H = 52
const PAD = 5

export function TempoSparkline({ beats, duration, global }: { beats: readonly number[]; duration: number; global: number | null }) {
  const t = useT()
  const line = useRef<SVGLineElement>(null)
  const dot = useRef<HTMLSpanElement>(null)
  const fillId = `tp-spark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  const chart = useMemo(() => {
    const curve = tempoCurve(beats, duration, 72)
    if (curve.length < 2) return null
    const vals = curve.map((p) => p.bpm)
    const ref = global ?? vals.reduce((a, b) => a + b, 0) / vals.length
    // Keep at least ±6 % of range so a steady song looks steady, not like a seismograph.
    const lo = Math.min(...vals, ref * 0.94)
    const hi = Math.max(...vals, ref * 1.06)
    const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2)
    const x = (time: number) => (time / duration) * W
    const pts = curve.map((p) => `${x(p.t).toFixed(1)},${y(p.bpm).toFixed(1)}`)
    const path = `M${pts.join('L')}`
    const area = `${path}L${W},${H}L0,${H}Z`
    const min = Math.round(Math.min(...vals))
    const max = Math.round(Math.max(...vals))
    return { curve, path, area, refY: y(ref), y, min, max, steady: (max - min) / ref < 0.03 }
  }, [beats, duration, global])

  useClockEffect(
    (time) => {
      if (!chart) return
      const p = Math.min(1, Math.max(0, time / duration))
      const px = (p * W).toFixed(1)
      if (line.current) {
        line.current.setAttribute('x1', px)
        line.current.setAttribute('x2', px)
      }
      if (dot.current) {
        const c = chart.curve
        const f = p * (c.length - 1)
        const i = Math.min(c.length - 2, Math.floor(f))
        const v = c[i].bpm + (c[i + 1].bpm - c[i].bpm) * (f - i)
        dot.current.style.left = `${p * 100}%`
        dot.current.style.top = `${(chart.y(v) / H) * 100}%`
      }
    },
    [chart, duration],
  )

  if (!chart) {
    return (
      <div className="flex h-[52px] items-center justify-center rounded-lg bg-surface text-xs text-faint">{t('tempo.curve.none')}</div>
    )
  }

  return (
    <figure className="m-0">
      <div className="relative h-[52px] overflow-hidden rounded-lg bg-surface">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 block size-full" aria-hidden>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={chart.area} fill={`url(#${fillId})`} />
          <line x1="0" x2={W} y1={chart.refY} y2={chart.refY} stroke="var(--faint)" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={chart.path} fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <line ref={line} x1="0" x2="0" y1="0" y2={H} stroke="var(--playhead)" strokeOpacity="0.55" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
        <span
          ref={dot}
          aria-hidden
          className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
          style={{ left: 0, top: '50%' }}
        />
      </div>
      <figcaption className="mt-1.5 flex items-center justify-between text-[11px] text-faint">
        <span>{t('tempo.curve')}</span>
        <span className="font-mono tabular-nums">
          {chart.steady ? t('tempo.curve.steady') : t('tempo.curve.range', { min: chart.min, max: chart.max })}
        </span>
      </figcaption>
    </figure>
  )
}
