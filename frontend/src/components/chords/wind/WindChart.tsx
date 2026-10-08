import { memo, useId } from 'react'
import { MAX_ARPEGGIO, type Cover, type WindKey, type WindNote, type WindSpec } from '../../../lib/wind'
import { GAP, NAME_BAND, PAD, TOP_BAND } from './layout'
import './wind.css'

function KeyShape({ k, cover, color, clip }: { k: WindKey; cover: Cover; color: string; clip: string }) {
  const round = k.kind === 'hole'
  const shape = (props: React.SVGProps<SVGEllipseElement & SVGRectElement>) =>
    round ? (
      <ellipse cx={k.x} cy={k.y} rx={k.rx} ry={k.ry} {...props} />
    ) : (
      <rect x={k.x - k.rx} y={k.y - k.ry} width={2 * k.rx} height={2 * k.ry} rx={Math.min(k.rx, k.ry) * 0.7} {...props} />
    )
  return (
    <g>
      {shape({ strokeWidth: 0.5, strokeDasharray: k.back ? '0.9 0.6' : undefined, style: { fill: cover === 1 ? color : 'var(--wd-open)', stroke: cover ? color : 'var(--wd-open-stroke)' } })}
      {cover === 0.5 && shape({ clipPath: `url(#${clip})`, style: { fill: color } })}
    </g>
  )
}

/**
 * Fingering chart of a chord's arpeggio on a wind instrument: one column per note, the instrument's
 * holes / keys from the mouthpiece (its window / embouchure hole on top) down, covered ones filled in
 * the chord colour (half-covered: the lower half), the back (thumb) holes dashed at the side, a chevron
 * over an overblown note per register above the first, the note's name underneath — the root's in
 * the chord colour. A click on a column plays that note; a `sounding` column gets a ring that fades
 * as the note ends.
 */
export const WindChart = memo(function WindChart({
  spec,
  notes,
  color,
  width,
  title,
  octaves = true,
  sounding,
  onNote,
}: {
  spec: WindSpec
  notes: readonly WindNote[]
  color: string
  width: number
  title: string
  /** show the octave next to each name */
  octaves?: boolean
  /** note indices sounding right now (chord sound) */
  sounding?: ReadonlySet<number>
  onNote?(index: number): void
}) {
  const uid = `wd${useId().replace(/[^\w-]/g, '')}`
  const full = MAX_ARPEGGIO * spec.width + (MAX_ARPEGGIO - 1) * GAP
  const used = notes.length * spec.width + Math.max(0, notes.length - 1) * GAP
  const x0 = PAD + (full - used) / 2
  const vw = full + 2 * PAD
  const vh = spec.height + TOP_BAND + NAME_BAND + 2 * PAD
  const bodyX = spec.width / 2
  const keyXs = spec.keys.filter((k) => !k.back).map((k) => [k.x - k.rx, k.x + k.rx])
  const bodyHalf = Math.max(2.2, ...keyXs.map(([a, b]) => Math.max(bodyX - a, b - bodyX))) * 0.62

  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      width={width}
      height={(width * vh) / vw}
      role="img"
      aria-label={title}
      className="cw-wind block shrink-0 overflow-visible"
      data-instrument={spec.instrument}
    >
      <defs>
        {spec.keys.map((k, i) => (
          <clipPath key={i} id={`${uid}-h${i}`}>
            <rect x={k.x - k.rx - 1} y={k.y} width={2 * k.rx + 2} height={k.ry + 1} />
          </clipPath>
        ))}
      </defs>
      {notes.map((n, i) => {
        const x = x0 + i * (spec.width + GAP)
        const on = !!sounding?.has(i)
        const tint = n.role === 'tone' ? `color-mix(in oklch, ${color} 72%, var(--text))` : color
        const acc = n.name.slice(1)
        return (
          <g
            key={i}
            transform={`translate(${x} ${PAD + TOP_BAND})`}
            className="cw-wind-col"
            onClick={
              onNote
                ? (e) => {
                    e.stopPropagation()
                    onNote(i)
                  }
                : undefined
            }
            style={onNote ? { cursor: 'pointer' } : undefined}
          >
            {/* the hit area of the whole column */}
            <rect x={-GAP / 2} y={-PAD - TOP_BAND} width={spec.width + GAP} height={vh} fill="transparent" />
            {/* overblown: a chevron per register above the first ("blow harder") */}
            {Array.from({ length: n.register - 1 }, (_, r) => {
              const cx = bodyX + (r - (n.register - 2) / 2) * 2.6
              return (
                <path
                  key={r}
                  d={`M${cx - 1.1} ${-0.9}l1.1 -1.3l1.1 1.3`}
                  fill="none"
                  strokeWidth={0.55}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ stroke: tint }}
                />
              )
            })}
            <rect
              x={bodyX - bodyHalf}
              y={0.4}
              width={2 * bodyHalf}
              height={spec.height - 0.8}
              rx={bodyHalf}
              strokeWidth={0.4}
              style={{ fill: 'var(--wd-body)', stroke: 'var(--wd-body-stroke)' }}
            />
            {spec.head === 'window' ? (
              <rect x={bodyX - 1.15} y={2} width={2.3} height={1.5} rx={0.3} style={{ fill: 'var(--wd-body-stroke)' }} />
            ) : (
              <ellipse cx={bodyX} cy={2.6} rx={1.25} ry={0.85} style={{ fill: 'var(--wd-body-stroke)' }} />
            )}
            <line
              x1={bodyX - bodyHalf - 1.2}
              x2={bodyX + bodyHalf + 1.2}
              y1={spec.handBreak}
              y2={spec.handBreak}
              strokeWidth={0.35}
              strokeDasharray="0.8 0.7"
              style={{ stroke: 'var(--wd-break)' }}
            />
            {spec.keys.map((k, j) => (
              <KeyShape key={k.id} k={k} cover={n.cover[j] ?? 0} color={tint} clip={`${uid}-h${j}`} />
            ))}
            <text
              x={spec.width / 2}
              y={spec.height + NAME_BAND / 2 + 0.6}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={4.6}
              fontWeight={n.role === 'tone' ? 600 : 700}
              style={{ fill: n.role === 'tone' ? 'var(--wd-label)' : color, fontFamily: 'var(--font-display)', pointerEvents: 'none' }}
            >
              {n.name.charAt(0)}
              {acc && <tspan fontSize="0.8em">{acc.replace(/#/g, '♯').replace(/b/g, '♭')}</tspan>}
              {octaves && (
                <tspan fontSize="0.62em" fontWeight={500} dx={0.2} dy={1} style={{ fill: 'var(--wd-octave)' }}>
                  {n.octave}
                </tspan>
              )}
            </text>
            {sounding && (
              <rect
                x={-GAP / 2 + 0.2}
                y={-TOP_BAND - 0.4}
                width={spec.width + GAP - 0.4}
                height={spec.height + TOP_BAND + NAME_BAND + 0.4}
                rx={2.4}
                fill="none"
                strokeWidth={0.7}
                pointerEvents="none"
                style={{ stroke: color, opacity: on ? 0.95 : 0, transition: on ? 'none' : 'opacity 700ms ease-out' }}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
})
