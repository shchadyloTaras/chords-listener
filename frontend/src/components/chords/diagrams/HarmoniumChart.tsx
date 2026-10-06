import { memo, useId } from 'react'
import { HARMONIUM_WHITES, harmoniumKeys, harmoniumWhiteSlot, isHarmoniumBlack, type HarmoniumVoicing } from '../../../lib/diagrams/harmonium'

// The hand harmonium as the player sees it from the seat, foreshortened: the 37 keys at the
// bottom, the blue felt behind them, the carved wooden panel, the bellows at the back (top).
// Units: a white key is 10 wide.
const WW = 10
const SIDE = 4 // wooden cheek beside the keys
const W = HARMONIUM_WHITES * WW + 2 * SIDE
const BELLOWS = 14
const PANEL_Y = BELLOWS + 1.5
const PANEL_H = 26
const FELT_Y = PANEL_Y + PANEL_H + 1
const FELT_H = 2.5
const KEY_Y = FELT_Y + FELT_H
const WH = 40 // white key length
const WR = 3.2 // rounded front ends of the white keys
const BW = 6
const BH = 23.5 // black keys ~59 % of the white length
const BR = 1.4
const H = KEY_Y + WH + 2.5 // a strip of the case in front of the keys

/** height / width of the chart */
export const HARMONIUM_ASPECT = (H + 2) / (W + 2)

// The real instrument's colours, the same in both themes (only the outline follows the theme).
const IVORY = '#f4ecd8'
const IVORY_BACK = '#ddd0b2'
const IVORY_FRONT = '#faf5e9'
const KEY_GAP = '#5b4730'
const EBONY = '#1a1512'
const EBONY_HI = '#3b322c'
const WOOD_LO = '#ad7530'
const WOOD = '#c98e3f'
const WOOD_HI = '#dba75a'
const GRAIN = '#6e4418'
const CUT_EDGE = '#5a3511'
const VIOLET = '#3a2a7a'
const FELT_HI = '#3243a6'
const FELT_LO = '#1e2872'
const BELLOWS_DARK = '#15110f'
const BELLOWS_FOLD = '#342a24'
const MARKER = '#16110e'

const KEYS = harmoniumKeys()

const wx = (k: number) => SIDE + harmoniumWhiteSlot(k) * WW
const bx = (k: number) => wx(k) + WW - BW / 2

const r2 = (n: number) => Math.round(n * 100) / 100

/** A key from its back edge (y) to its rounded front end. */
function keyPath(x: number, w: number, y: number, length: number, r: number): string {
  const b = r2(KEY_Y + length)
  const [x0, x1] = [r2(x), r2(x + w)]
  return `M${x0} ${r2(y)}H${x1}V${r2(b - r)}A${r} ${r} 0 0 1 ${r2(x1 - r)} ${b}H${r2(x0 + r)}A${r} ${r} 0 0 1 ${x0} ${r2(b - r)}Z`
}

const whitePath = (k: number) => keyPath(wx(k) + 0.4, WW - 0.8, KEY_Y, WH, WR)
const blackPath = (k: number) => keyPath(bx(k), BW, KEY_Y - 0.3, BH, BR)

/** A sounding key goes down a step (instantly) and comes back up when released. */
const press = (k: number, on: boolean) =>
  on ? { transform: `translateY(${isHarmoniumBlack(k) ? 0.6 : 0.9}px)`, transition: 'none' } : { transition: 'transform 160ms ease-out' }

// ---------- the carved panel: one half, mirrored about the centre ----------

const CX = W / 2
const CY = PANEL_Y + PANEL_H / 2

/** A fan of five petals at the outer end, opening outwards. */
const FAN = [120, 150, 180, 210, 240].map((deg) => {
  const at = (r: number, d: number) => {
    const a = (d * Math.PI) / 180
    return `${r2(21 + r * Math.cos(a))} ${r2(CY + r * Math.sin(a))}`
  }
  return `M${at(2.4, deg)}L${at(7, deg - 9)}L${at(9.4, deg)}L${at(7, deg + 9)}Z`
})

const star = (x: number, y: number, s: number) =>
  `M${x} ${y - s}L${x + s * 0.28} ${y - s * 0.28}L${x + s} ${y}L${x + s * 0.28} ${y + s * 0.28}L${x} ${y + s}L${x - s * 0.28} ${y + s * 0.28}L${x - s} ${y}L${x - s * 0.28} ${y - s * 0.28}Z`

/** Long wavy slots towards the keys, then the hook that swirls in towards the centre (stroke widths). */
const SLOTS = [
  ...[0, 1, 2].map((i) => {
    const y = CY + 2.3 + i * 2.8
    const x = 34 + i * 2
    return { d: `M${x} ${y}C${x + 10} ${y - 1.6} ${x + 22} ${y + 1.6} ${x + 34} ${y}`, w: 1.45 }
  }),
  {
    d: `M78 ${CY + 8}C86 ${CY + 7.5} 92 ${CY + 3.5} 96 ${CY - 2.5}C99 ${CY - 7} 105 ${CY - 7} 106 ${CY - 3}C107 ${CY + 0.5} 102 ${CY + 2} 100.5 ${CY - 0.7}`,
    w: 1.45,
  },
  { d: `M84 ${CY + 9.5}C92 ${CY + 9} 98 ${CY + 5.5} 101 ${CY + 2.5}`, w: 1 },
]

/** Two rows of small square holes, each column under an arrow pointing to the back. */
const COLUMNS = [0, 1, 2, 3, 4, 5].map((j) => 40 + j * 5.4)
const SQUARE = 1.9

/** A small arrowhead pointing to the back, its tip at (x, y). */
const arrow = (x: number, y: number) => `M${x} ${y}L${x + 1.4} ${y + 2.6}L${x} ${y + 1.9}L${x - 1.4} ${y + 2.6}Z`

/** The cut-outs of one half (the violet cloth showing through), with a dark carved edge. */
function CarvedHalf({ mirror }: { mirror?: boolean }) {
  return (
    <g transform={mirror ? `translate(${W} 0) scale(-1 1)` : undefined}>
      <g fill={VIOLET} stroke={CUT_EDGE} strokeWidth={0.35} strokeLinejoin="round">
        {FAN.map((d) => (
          <path key={d} d={d} />
        ))}
        <circle cx={22.6} cy={CY} r={1.1} />
        <path d={star(30, PANEL_Y + 5.1, 1.8)} />
        <path d={star(30, PANEL_Y + PANEL_H - 5.1, 1.8)} />
        {COLUMNS.map((x) => (
          <g key={x}>
            <path d={arrow(x + SQUARE / 2, PANEL_Y + 2.8)} />
            <rect x={x} y={PANEL_Y + 7.4} width={SQUARE} height={SQUARE} />
            <rect x={x} y={PANEL_Y + 10.6} width={SQUARE} height={SQUARE} />
          </g>
        ))}
      </g>
      <g fill="none" strokeLinecap="round">
        {SLOTS.map(({ d, w }) => (
          <g key={d}>
            <path d={d} stroke={CUT_EDGE} strokeWidth={w + 0.65} />
            <path d={d} stroke={VIOLET} strokeWidth={w} />
          </g>
        ))}
      </g>
    </g>
  )
}

/** Bellows folds fanning out towards the low end, where the left hand pumps them; hinged at the high end. */
const FOLDS = 6
const foldY = (i: number, left: boolean) => {
  const top = left ? 0.5 : 4.5
  return r2(top + ((BELLOWS + 1 - top) * i) / FOLDS)
}

/** Everything that does not change with the chord: bellows, wooden body, carving, felt. */
const Body = memo(function Body({ uid }: { uid: string }) {
  const l = 1.5
  const r = W - 1.5
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-wood`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={WOOD_LO} />
          <stop offset="0.16" stopColor={WOOD} />
          <stop offset="0.5" stopColor={WOOD_HI} />
          <stop offset="1" stopColor={WOOD} />
        </linearGradient>
        <linearGradient id={`${uid}-felt`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={FELT_HI} />
          <stop offset="1" stopColor={FELT_LO} />
        </linearGradient>
        <linearGradient id={`${uid}-ivory`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={IVORY_BACK} />
          <stop offset="0.22" stopColor={IVORY} />
          <stop offset="1" stopColor={IVORY_FRONT} />
        </linearGradient>
        <linearGradient id={`${uid}-ebony`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={EBONY} />
          <stop offset="1" stopColor={EBONY_HI} />
        </linearGradient>
      </defs>

      {/* bellows */}
      <path d={`M${l} ${foldY(0, true)}L${r} ${foldY(0, false)}V${BELLOWS + 1}H${l}Z`} fill={BELLOWS_DARK} stroke="var(--hm-outline)" strokeWidth={0.6} />
      {Array.from({ length: FOLDS }, (_, i) =>
        i % 2 ? (
          <path key={i} d={`M${l} ${foldY(i, true)}L${r} ${foldY(i, false)}L${r} ${foldY(i + 1, false)}L${l} ${foldY(i + 1, true)}Z`} fill={BELLOWS_FOLD} />
        ) : null,
      )}
      {Array.from({ length: FOLDS - 1 }, (_, i) => (
        <path key={i} d={`M${l} ${foldY(i + 1, true)}L${r} ${foldY(i + 1, false)}`} stroke="rgb(255 255 255 / 0.18)" strokeWidth={0.4} />
      ))}

      {/* wooden body with the grain running along the instrument */}
      <rect x={0} y={BELLOWS} width={W} height={H - BELLOWS} rx={2.4} fill={`url(#${uid}-wood)`} stroke="var(--hm-outline)" strokeWidth={0.6} />
      <g fill="none" stroke={GRAIN} strokeWidth={0.45} opacity={0.18}>
        {[3, 8.5, 14, 19.5, 24.5].map((dy, i) => (
          <path key={dy} d={`M2 ${PANEL_Y + dy}C${60 + i * 9} ${PANEL_Y + dy - 0.9} ${130 - i * 7} ${PANEL_Y + dy + 1} ${W - 2} ${PANEL_Y + dy - 0.3}`} />
        ))}
      </g>
      {/* the panel's bevelled frame */}
      <rect x={SIDE + 1} y={PANEL_Y + 0.5} width={W - 2 * SIDE - 2} height={PANEL_H} rx={1.6} fill="none" stroke="rgb(255 236 196 / 0.4)" strokeWidth={0.5} />
      <rect x={SIDE + 1} y={PANEL_Y} width={W - 2 * SIDE - 2} height={PANEL_H} rx={1.6} fill="none" stroke={GRAIN} strokeOpacity={0.6} strokeWidth={0.5} />

      <CarvedHalf />
      <CarvedHalf mirror />
      <path d={`M${CX} ${CY - 2.4}L${CX + 2.2} ${CY}L${CX} ${CY + 2.4}L${CX - 2.2} ${CY}Z`} fill={VIOLET} stroke={CUT_EDGE} strokeWidth={0.35} />
      <circle cx={CX} cy={PANEL_Y + 5.4} r={0.9} fill={VIOLET} stroke={CUT_EDGE} strokeWidth={0.3} />
      <circle cx={CX} cy={PANEL_Y + PANEL_H - 5.4} r={0.9} fill={VIOLET} stroke={CUT_EDGE} strokeWidth={0.3} />

      {/* felt strip behind the keys */}
      <rect x={SIDE} y={FELT_Y} width={W - 2 * SIDE} height={FELT_H} fill={`url(#${uid}-felt)`} />
    </>
  )
})

/**
 * The 37-key hand harmonium (C3–C6) with chord tones lit in the chord color; the bass gets a
 * marker. With `onKey` every key is clickable; `sounding` keys (the chord sound playing them) are
 * drawn pressed under a light (dark theme) / deep (light theme) sheen that fades as they are
 * released — like PianoChart.
 */
export const HarmoniumChart = memo(function HarmoniumChart({
  voicing,
  color,
  width,
  title,
  sounding,
  onKey,
}: {
  voicing: HarmoniumVoicing
  color: string
  width: number
  title: string
  /** key indices sounding right now (0 = C3) */
  sounding?: ReadonlySet<number>
  onKey?(key: number): void
}) {
  const uid = `hm${useId().replace(/[^\w-]/g, '')}`
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

  /** Sheen over a sounding key: the text colour over chord tones, the chord colour over other keys. */
  const sheen = (k: number, d: string) => (
    <path
      key={`s${k}`}
      d={d}
      pointerEvents="none"
      fill={lit.has(k) ? 'var(--text)' : color}
      style={{
        ...press(k, on(k)),
        opacity: on(k) ? (lit.has(k) ? 0.4 : 0.6) : 0,
        transition: on(k) ? 'none' : 'opacity 320ms ease-out, transform 160ms ease-out',
      }}
    />
  )
  const bassBlack = isHarmoniumBlack(voicing.bass)

  return (
    <svg
      viewBox={`-1 -1 ${W + 2} ${H + 2}`}
      width={width}
      height={width * HARMONIUM_ASPECT}
      role="img"
      aria-label={title}
      className="cw-harmonium block shrink-0"
    >
      <Body uid={uid} />
      {KEYS.whites.map((k) => (
        <path
          key={k}
          d={whitePath(k)}
          fill={lit.has(k) ? color : `url(#${uid}-ivory)`}
          stroke={KEY_GAP}
          strokeOpacity={0.6}
          strokeWidth={0.6}
          style={{ ...press(k, on(k)), cursor }}
          onClick={click(k)}
        />
      ))}
      {sounding && KEYS.whites.map((k) => sheen(k, whitePath(k)))}
      {KEYS.blacks.map((k) => (
        <g key={k} style={{ ...press(k, on(k)), cursor }} onClick={click(k)}>
          <path d={blackPath(k)} fill={lit.has(k) ? color : `url(#${uid}-ebony)`} stroke={lit.has(k) ? EBONY : 'none'} strokeWidth={0.8} />
          {!lit.has(k) && <rect x={bx(k) + BW * 0.2} y={KEY_Y + 1} width={BW * 0.16} height={BH - 4} rx={0.4} fill="rgb(255 255 255 / 0.1)" />}
        </g>
      ))}
      {sounding && KEYS.blacks.map((k) => sheen(k, blackPath(k)))}
      {lit.has(voicing.bass) && (
        <circle
          cx={bassBlack ? bx(voicing.bass) + BW / 2 : wx(voicing.bass) + WW / 2}
          cy={bassBlack ? KEY_Y + BH - 5 : KEY_Y + WH - 6.5}
          r={2}
          fill={MARKER}
          style={{ ...press(voicing.bass, on(voicing.bass)), pointerEvents: 'none' }}
        />
      )}
    </svg>
  )
})
