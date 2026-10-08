// The tuner's meter: an arc from −50 to +50 cents with a tick every 10, the green «in tune» zone, and a
// needle that springs to the deviation (back to the middle, dimmed, when no note is heard).

import clsx from 'clsx'
import { motion } from 'framer-motion'
import { IN_TUNE_CENTS } from '../../lib/tuner/notes'

const CX = 120
const CY = 126
const R = 100
/** ±50 cents span ±60° of the arc */
const SPAN_DEG = 60
const TICKS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]

const angle = (cents: number) => (Math.max(-50, Math.min(50, cents)) / 50) * SPAN_DEG

function point(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)]
}

function arc(fromDeg: number, toDeg: number, r: number): string {
  const [x1, y1] = point(fromDeg, r)
  const [x2, y2] = point(toDeg, r)
  return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`
}

export function TunerDial({ cents, inTune, label }: { cents: number | null; inTune: boolean; label: string }) {
  const idle = cents === null
  return (
    <svg viewBox="0 0 240 140" role="img" aria-label={label} className="w-full max-w-[26rem]">
      <path d={arc(-SPAN_DEG, SPAN_DEG, R)} fill="none" className="stroke-border-strong" strokeWidth={2} />
      <path
        d={arc(angle(-IN_TUNE_CENTS), angle(IN_TUNE_CENTS), R)}
        fill="none"
        className={clsx('stroke-success transition-opacity', inTune ? 'opacity-100' : 'opacity-45')}
        strokeWidth={inTune ? 8 : 5}
        strokeLinecap="round"
      />
      {TICKS.map((c) => {
        const [x1, y1] = point(angle(c), R - (c === 0 ? 16 : c % 50 === 0 ? 12 : 8))
        const [x2, y2] = point(angle(c), R - 2)
        return <line key={c} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-muted" strokeWidth={c === 0 ? 2 : 1} />
      })}
      {[-50, 50].map((c) => {
        const [x, y] = point(angle(c), R - 26)
        return (
          <text key={c} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-faint font-mono text-[9px]">
            {c > 0 ? '+50' : '−50'}
          </text>
        )
      })}
      <motion.path
        d={`M ${CX - 2.5} ${CY} L ${CX} ${CY - R + 6} L ${CX + 2.5} ${CY} Z`}
        className={inTune ? 'fill-success' : 'fill-accent'}
        style={{ originX: 0.5, originY: 1 }}
        initial={false}
        animate={{ rotate: idle ? 0 : angle(cents), opacity: idle ? 0.3 : 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 24, mass: 0.7 }}
      />
      <circle cx={CX} cy={CY} r={6} className="fill-text" />
    </svg>
  )
}
