import { memo, useId } from 'react'
import { HANDPAN_MIN_FIELD, handpanFieldSizes, type FieldRole, type HandpanNote, type HandpanScale } from '../../../lib/handpan'
import '../handpan/handpan.css'

const C = 50
const SHELL_R = 46.2
const DING_R = 11.8
/** No tone field narrower than this (half-width), so its name still fits. */
const MIN_RX = 4.3

interface FieldGeom {
  x: number
  y: number
  /** tangential half-width */
  rx: number
  /** radial half-length */
  ry: number
  /** rotation (deg) that points the long axis at the centre */
  rot: number
  /** label font size */
  fs: number
}

const geomCache = new Map<string, FieldGeom[]>()

/**
 * Top-down layout: ding in the centre, tone fields on a ring in physical order — clockwise from
 * the bottom (the field nearest the player). The lowest field is the largest and the fields get
 * smaller as they go up in pitch, like on a real instrument (octaves inferred when the scale has
 * none); the ding keeps its size.
 */
function layout(scale: HandpanScale): FieldGeom[] {
  const cached = geomCache.get(scale.key)
  if (cached) return cached
  const n = scale.tones.length
  const ring = n > 10 ? 32.6 : 31.6
  const spacing = (2 * Math.PI * ring) / n
  const rxMax = Math.min(8.6, spacing * 0.37)
  const ryMax = Math.min(11.6, rxMax * 1.38)
  const fs = Math.max(5.4, Math.min(7.8, rxMax * 0.92))
  // on a crowded ring the fields are small already: narrow the range so the top ones keep a name
  const floor = Math.min(1, Math.max(HANDPAN_MIN_FIELD, MIN_RX / rxMax))
  const size = handpanFieldSizes(scale).map((s) => 1 - ((1 - s) * (1 - floor)) / (1 - HANDPAN_MIN_FIELD))
  const out: FieldGeom[] = [{ x: C, y: C, rx: DING_R, ry: DING_R, rot: 0, fs: 9.4 }]
  scale.tones.forEach((_, i) => {
    const deg = 90 + (i * 360) / n
    const a = (deg * Math.PI) / 180
    out.push({
      x: C + ring * Math.cos(a),
      y: C + ring * Math.sin(a),
      rx: rxMax * size[i],
      ry: ryMax * size[i],
      rot: deg - 90,
      // the name shrinks less than the field, so it stays readable
      fs: fs * (0.6 + 0.4 * size[i]),
    })
  })
  if (geomCache.size > 64) geomCache.clear()
  geomCache.set(scale.key, out)
  return out
}

interface Look {
  fill: string
  stroke: string
  strokeWidth: number
  dash?: string
  label: string
  weight: number
  halo: boolean
  opacity: number
}

function look(role: FieldRole | null, color: string, anyLit: boolean): Look {
  if (role === 'root')
    return { fill: color, stroke: color, strokeWidth: 1, label: 'var(--bg)', weight: 700, halo: true, opacity: 1 }
  if (role === 'bass')
    return { fill: 'var(--hp-field)', stroke: color, strokeWidth: 1.1, dash: '2.2 1.6', label: 'var(--hp-label)', weight: 600, halo: false, opacity: 1 }
  if (role)
    return {
      fill: `color-mix(in oklch, ${color} 46%, var(--hp-shell))`,
      stroke: color,
      strokeWidth: 1.1,
      label: 'var(--hp-label)',
      weight: 700,
      halo: false,
      opacity: 1,
    }
  return {
    fill: 'var(--hp-field)',
    stroke: 'var(--hp-field-stroke)',
    strokeWidth: 0.7,
    label: anyLit ? 'var(--hp-label-dim)' : 'var(--hp-label)',
    weight: 500,
    halo: false,
    opacity: anyLit ? 0.7 : 1,
  }
}

function NoteLabel({ note, x, y, fs, fill, weight, octave }: { note: HandpanNote; x: number; y: number; fs: number; fill: string; weight: number; octave: boolean }) {
  const acc = note.name.charAt(1)
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={fs}
      fontWeight={weight}
      style={{ fill, fontFamily: 'var(--font-display)', pointerEvents: 'none' }}
    >
      {note.name.charAt(0)}
      {acc && <tspan fontSize="0.8em">{acc === '#' ? '♯' : '♭'}</tspan>}
      {octave && note.octave != null && (
        <tspan fontSize="0.6em" fontWeight={500} opacity={0.72} dx={0.3} dy={fs * 0.22}>
          {note.octave}
        </tspan>
      )}
    </text>
  )
}

/**
 * Top-down handpan: steel shell, ding in the centre, tone fields around it. Fields playing the
 * chord light up — root solid in the chord colour with a halo, other chord tones tinted, a slash
 * bass dashed — and everything else dims. Every field with a chord tone's pitch class is lit.
 * `sounding` fields (struck by the chord sound) get a ring that fades as the note rings out.
 */
export const HandpanChart = memo(function HandpanChart({
  scale,
  roles,
  color,
  width,
  title,
  labels = 'all',
  octaves = false,
  highlight = null,
  onFieldClick,
  sounding,
}: {
  scale: HandpanScale
  /** role per note index (ding = 0); null → nothing lit */
  roles: readonly (FieldRole | null)[] | null
  color: string
  width: number
  title: string
  /** which fields carry their note name */
  labels?: 'all' | 'lit'
  /** show known octaves next to the note names */
  octaves?: boolean
  /** a note index to mark in the accent colour (editor preview) */
  highlight?: number | null
  onFieldClick?(index: number): void
  /** note indices sounding right now (chord sound) */
  sounding?: ReadonlySet<number>
}) {
  const uid = `hp${useId().replace(/[^\w-]/g, '')}`
  const geom = layout(scale)
  const anyLit = !!roles?.some((r) => r != null)

  return (
    <svg
      viewBox="-1 -1 102 102"
      width={width}
      height={width}
      role="img"
      aria-label={title}
      className="cw-handpan block shrink-0 overflow-visible"
    >
      <defs>
        <radialGradient id={`${uid}-shell`} cx="40%" cy="34%" r="74%">
          <stop offset="0" style={{ stopColor: 'var(--hp-shell-hi)' }} />
          <stop offset="0.58" style={{ stopColor: 'var(--hp-shell)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hp-shell-lo)' }} />
        </radialGradient>
        <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--hp-rim)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hp-rim-lo)' }} />
        </linearGradient>
        <radialGradient id={`${uid}-dome`} cx="42%" cy="36%" r="62%">
          <stop offset="0" style={{ stopColor: 'var(--hp-sheen)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hp-sheen)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>

      {/* shell + rim */}
      <circle cx={C} cy={C} r={SHELL_R + 2.6} style={{ fill: `url(#${uid}-rim)` }} />
      <circle cx={C} cy={C} r={SHELL_R} style={{ fill: `url(#${uid}-shell)` }} />
      <ellipse cx={38} cy={27} rx={24} ry={11} transform="rotate(-28 38 27)" style={{ fill: `url(#${uid}-dome)` }} opacity={0.75} />

      {geom.map((g, i) => {
        const note = scale.notes[i]
        const role: FieldRole | null = highlight === i ? 'root' : (roles?.[i] ?? null)
        const tint = highlight === i ? 'var(--accent)' : color
        const l = look(role, tint, anyLit || highlight != null)
        const showLabel = labels === 'all' || role != null
        const isDing = i === 0
        const struck = !!sounding?.has(i)
        return (
          <g
            key={i}
            opacity={struck ? 1 : l.opacity}
            className="cw-hp-field"
            onClick={
              onFieldClick
                ? (e) => {
                    e.stopPropagation()
                    onFieldClick(i)
                  }
                : undefined
            }
            style={onFieldClick ? { cursor: 'pointer' } : undefined}
          >
            {l.halo && (
              <ellipse
                className="cw-hp-halo"
                cx={g.x}
                cy={g.y}
                rx={g.rx + 2.1}
                ry={g.ry + 2.1}
                transform={`rotate(${g.rot} ${g.x} ${g.y})`}
                fill="none"
                strokeWidth={1.3}
                style={{ stroke: tint }}
                opacity={0.42}
              />
            )}
            <ellipse
              className="cw-hp-field"
              cx={g.x}
              cy={g.y}
              rx={g.rx}
              ry={g.ry}
              transform={`rotate(${g.rot} ${g.x} ${g.y})`}
              strokeWidth={l.strokeWidth}
              strokeDasharray={l.dash}
              style={{ fill: l.fill, stroke: l.stroke }}
            />
            {/* the dimple (ding: a dome highlight) */}
            {isDing ? (
              <circle cx={g.x - 2.2} cy={g.y - 2.6} r={g.rx * 0.62} style={{ fill: `url(#${uid}-dome)` }} opacity={role ? 0.45 : 0.9} />
            ) : (
              <ellipse
                cx={g.x}
                cy={g.y}
                rx={g.rx * 0.5}
                ry={g.ry * 0.5}
                transform={`rotate(${g.rot} ${g.x} ${g.y})`}
                style={{ fill: 'var(--hp-dimple)' }}
                opacity={role ? 0.45 : 1}
              />
            )}
            {showLabel && (
              <NoteLabel note={note} x={g.x} y={g.y} fs={g.fs} fill={l.label} weight={l.weight} octave={octaves} />
            )}
            {sounding && (
              <ellipse
                cx={g.x}
                cy={g.y}
                rx={g.rx + 2.6}
                ry={g.ry + 2.6}
                transform={`rotate(${g.rot} ${g.x} ${g.y})`}
                fill="none"
                strokeWidth={1.6}
                pointerEvents="none"
                style={{ stroke: color, opacity: struck ? 0.95 : 0, transition: struck ? 'none' : 'opacity 700ms ease-out' }}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
})
