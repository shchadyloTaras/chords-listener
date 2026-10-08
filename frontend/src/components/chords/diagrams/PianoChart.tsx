import { memo } from 'react'
import { BLACK_PCS, PIANO_KEYS, type PianoVoicing } from '../../../lib/diagrams/piano'

const WW = 14 // white key width
const WH = 64
const BW = 9
const BH = 39
/** white-key index within an octave for each pitch class (black keys: index of the white key to their left) */
const WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

/** A sounding key goes down a step (instantly) and comes back up when released. */
const press = (k: number, on: boolean) =>
  on ? { transform: `translateY(${BLACK_PCS.has(k % 12) ? 0.6 : 0.9}px)`, transition: 'none' } : { transition: 'transform 160ms ease-out' }

/** Height / width of the drawing (C2–C5: 22 white keys). */
export const PIANO_ASPECT = (WH + 4) / (22 * WW + 2)

/**
 * The keys both hands use, C2–C5 (key 0 = C2), with the chord lit in the chord color: the left
 * hand's bass, marked with a dot, low; the right hand's chord around middle C. With `onKey` every key
 * is clickable; `sounding` keys (the chord sound playing them) are drawn pressed under a light (dark
 * theme) / deep (light theme) sheen that fades as they are released.
 */
export const PianoChart = memo(function PianoChart({
  voicing,
  color,
  width,
  title,
  sounding,
  onKey,
}: {
  voicing: PianoVoicing
  color: string
  width: number
  title: string
  /** key indices sounding right now */
  sounding?: ReadonlySet<number>
  onKey?(key: number): void
}) {
  const lit = new Set(voicing.notes)
  const on = (k: number) => !!sounding?.has(k)
  const click = (k: number) =>
    onKey
      ? (e: React.MouseEvent) => {
          e.stopPropagation()
          onKey(k)
        }
      : undefined
  const cursor = onKey ? 'pointer' : undefined
  const whites: number[] = []
  const blacks: number[] = []
  for (let k = 0; k < PIANO_KEYS; k++) (BLACK_PCS.has(k % 12) ? blacks : whites).push(k)
  const w = whites.length * WW
  const h = WH + 2
  const wx = (k: number) => (Math.floor(k / 12) * 7 + WHITE_INDEX[k % 12]) * WW
  const bx = (k: number) => wx(k) + WW - BW / 2

  /** Sheen over a sounding key: the text colour over chord tones, the chord colour over other keys. */
  const sheen = (k: number, x: number, kw: number, kh: number, rx: number) => (
    <rect
      key={`s${k}`}
      x={x}
      y={0}
      width={kw}
      height={kh}
      rx={rx}
      pointerEvents="none"
      fill={lit.has(k) ? 'var(--text)' : color}
      style={{
        ...press(k, on(k)),
        opacity: on(k) ? (lit.has(k) ? 0.4 : 0.6) : 0,
        transition: on(k) ? 'none' : 'opacity 320ms ease-out, transform 160ms ease-out',
      }}
    />
  )

  return (
    <svg viewBox={`-1 -1 ${w + 2} ${h + 2}`} width={width} height={(width * (h + 2)) / (w + 2)} role="img" aria-label={title} className="cw-piano block shrink-0 text-muted">
      {whites.map((k) => (
        <rect
          key={k}
          x={wx(k) + 0.5}
          y={0}
          width={WW - 1}
          height={WH}
          rx={2.5}
          fill={lit.has(k) ? color : 'var(--cw-key-white)'}
          stroke="var(--cw-key-black)"
          strokeOpacity={0.5}
          strokeWidth={0.8}
          style={{ ...press(k, on(k)), cursor }}
          onClick={click(k)}
        />
      ))}
      {sounding && whites.map((k) => sheen(k, wx(k) + 0.5, WW - 1, WH, 2.5))}
      {blacks.map((k) => (
        <rect
          key={k}
          x={bx(k)}
          y={0}
          width={BW}
          height={BH}
          rx={2}
          fill={lit.has(k) ? color : 'var(--cw-key-black)'}
          stroke={lit.has(k) ? 'var(--cw-key-black)' : 'none'}
          strokeWidth={1}
          style={{ ...press(k, on(k)), cursor }}
          onClick={click(k)}
        />
      ))}
      {sounding && blacks.map((k) => sheen(k, bx(k), BW, BH, 2))}
      {lit.has(voicing.bass) && (
        <circle
          cx={BLACK_PCS.has(voicing.bass % 12) ? bx(voicing.bass) + BW / 2 : wx(voicing.bass) + WW / 2}
          cy={BLACK_PCS.has(voicing.bass % 12) ? BH - 7 : WH - 8}
          r={2.6}
          fill="var(--cw-key-black)"
          style={{ ...press(voicing.bass, on(voicing.bass)), pointerEvents: 'none' }}
        />
      )}
    </svg>
  )
})
