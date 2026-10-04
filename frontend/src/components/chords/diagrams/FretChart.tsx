import { memo } from 'react'
import type { Voicing } from '../../../lib/diagrams/chordsDb'

const SX = 15 // string spacing
const FY = 19 // fret spacing
const PAD_L = 20
const PAD_R = 8
const PAD_T = 20
const PAD_B = 6
const R = 6.2

/**
 * Fretboard chord chart (strings vertical, low string left). Theme-aware: lines use
 * currentColor; dots and barres use the chord color; finger digits use the page background.
 */
export const FretChart = memo(function FretChart({
  voicing,
  strings,
  color,
  width,
  title,
}: {
  voicing: Voicing
  strings: number
  color: string
  width: number
  title: string
}) {
  const frets = Math.max(4, ...voicing.frets)
  const w = PAD_L + (strings - 1) * SX + PAD_R
  const h = PAD_T + frets * FY + PAD_B
  const x = (s: number) => PAD_L + s * SX
  const y = (f: number) => PAD_T + (f - 0.5) * FY
  const open = voicing.baseFret <= 1

  const barres = voicing.barres
    .map((b) => {
      const idx = voicing.frets.map((f, i) => (f === b ? i : -1)).filter((i) => i >= 0)
      if (idx.length < 2) return null
      const first = idx[0]
      const last = idx[idx.length - 1]
      const finger = voicing.fingers[first] || 1
      return { fret: b, first, last, finger }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
  const inBarre = (s: number, f: number) => barres.some((b) => b.fret === f && s >= b.first && s <= b.last)

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={width}
      height={(width * h) / w}
      role="img"
      aria-label={title}
      className="block shrink-0 overflow-visible text-muted"
    >
      {/* frets */}
      {Array.from({ length: frets + 1 }, (_, i) => (
        <line
          key={`f${i}`}
          x1={x(0)}
          x2={x(strings - 1)}
          y1={PAD_T + i * FY}
          y2={PAD_T + i * FY}
          stroke="currentColor"
          strokeOpacity={i === 0 && open ? 1 : 0.45}
          strokeWidth={i === 0 && open ? 3.2 : 1}
          strokeLinecap="round"
        />
      ))}
      {/* strings */}
      {Array.from({ length: strings }, (_, s) => (
        <line key={`s${s}`} x1={x(s)} x2={x(s)} y1={PAD_T} y2={PAD_T + frets * FY} stroke="currentColor" strokeOpacity={0.55} strokeWidth={1} />
      ))}
      {!open && (
        <text x={PAD_L - 7} y={y(1) + 3.5} textAnchor="end" fontSize={10} fontWeight={600} fill="currentColor" style={{ fontFamily: 'var(--font-mono)' }}>
          {voicing.baseFret}
        </text>
      )}
      {/* open / muted markers */}
      {voicing.frets.map((f, s) =>
        f === 0 ? (
          <circle key={`o${s}`} cx={x(s)} cy={PAD_T - 9} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.3} />
        ) : f < 0 ? (
          <g key={`m${s}`} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" opacity={0.8}>
            <line x1={x(s) - 3.2} x2={x(s) + 3.2} y1={PAD_T - 12.2} y2={PAD_T - 5.8} />
            <line x1={x(s) + 3.2} x2={x(s) - 3.2} y1={PAD_T - 12.2} y2={PAD_T - 5.8} />
          </g>
        ) : null,
      )}
      {/* barres */}
      {barres.map((b) => (
        <g key={`b${b.fret}`}>
          <rect x={x(b.first) - R} y={y(b.fret) - R} width={x(b.last) - x(b.first) + 2 * R} height={2 * R} rx={R} fill={color} />
          <text x={x(b.first)} y={y(b.fret) + 3.1} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="var(--bg)">
            {b.finger}
          </text>
        </g>
      ))}
      {/* dots */}
      {voicing.frets.map((f, s) =>
        f > 0 && !inBarre(s, f) ? (
          <g key={`d${s}`}>
            <circle cx={x(s)} cy={y(f)} r={R} fill={color} />
            {voicing.fingers[s] > 0 && (
              <text x={x(s)} y={y(f) + 3.1} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="var(--bg)">
                {voicing.fingers[s]}
              </text>
            )}
          </g>
        ) : null,
      )}
    </svg>
  )
})
