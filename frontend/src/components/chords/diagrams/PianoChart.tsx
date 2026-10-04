import { memo } from 'react'
import { BLACK_PCS, PIANO_KEYS, type PianoVoicing } from '../../../lib/diagrams/piano'

const WW = 14 // white key width
const WH = 58
const BW = 9
const BH = 35
/** white-key index within an octave for each pitch class (black keys: index of the white key to their left) */
const WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

/** Two-octave keyboard with chord tones lit in the chord color; the bass gets a marker. */
export const PianoChart = memo(function PianoChart({
  voicing,
  color,
  width,
  title,
}: {
  voicing: PianoVoicing
  color: string
  width: number
  title: string
}) {
  const lit = new Set(voicing.notes)
  const whites: number[] = []
  const blacks: number[] = []
  for (let k = 0; k < PIANO_KEYS; k++) (BLACK_PCS.has(k % 12) ? blacks : whites).push(k)
  const w = whites.length * WW
  const h = WH + 2
  const wx = (k: number) => (Math.floor(k / 12) * 7 + WHITE_INDEX[k % 12]) * WW
  const bx = (k: number) => wx(k) + WW - BW / 2

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
        />
      ))}
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
        />
      ))}
      {lit.has(voicing.bass) && (
        <circle
          cx={BLACK_PCS.has(voicing.bass % 12) ? bx(voicing.bass) + BW / 2 : wx(voicing.bass) + WW / 2}
          cy={BLACK_PCS.has(voicing.bass % 12) ? BH - 7 : WH - 8}
          r={2.6}
          fill="var(--cw-key-black)"
        />
      )}
    </svg>
  )
})
