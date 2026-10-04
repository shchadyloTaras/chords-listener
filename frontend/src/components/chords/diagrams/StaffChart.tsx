import '@fontsource/noto-music/music.css'
import { memo } from 'react'
import type { SpelledNote, StaffChord } from '../../../lib/diagrams/staff'

// Units: one staff space = 6, so a staff step (line → space) = 3.
const STEP = 3
const TREBLE_TOP = 17 // y of the F5 line
const BASS_TOP = TREBLE_TOP + 24 + 21 // y of the A3 line
const W = 74
const H = BASS_TOP + 24 + 9
const NOTE_X = 50
const SECOND_DX = 7.6 // notehead shifted right when it sits a second above its neighbour
const ACC_DX = 9
const ACC_COL = 6.5

const trebleY = (step: number) => TREBLE_TOP + (38 - step) * STEP // F5 = step 38
const bassY = (step: number) => BASS_TOP + (26 - step) * STEP // A3 = step 26

const ACCIDENTAL_GLYPH: Record<number, string> = {
  [-2]: '\u{1D12B}',
  [-1]: '♭',
  1: '♯',
  2: '\u{1D12A}',
}

/** Closed path of a rotated ellipse (two half arcs between the ends of its major axis). */
function ellipse(cx: number, cy: number, rx: number, ry: number, deg: number) {
  const r = (deg * Math.PI) / 180
  const dx = rx * Math.cos(r)
  const dy = rx * Math.sin(r)
  return `M${cx + dx} ${cy + dy}A${rx} ${ry} ${deg} 1 0 ${cx - dx} ${cy - dy}A${rx} ${ry} ${deg} 1 0 ${cx + dx} ${cy + dy}Z`
}

/** Whole note: tilted oval with an oval hole tilted the other way. */
const wholeNote = (cx: number, cy: number) => ellipse(cx, cy, 4.3, 2.95, -18) + ellipse(cx, cy, 2.05, 1.45, 58)

interface Placed {
  note: SpelledNote
  x: number
  y: number
  accX: number
}

/** Seconds displace the upper note; accidentals stack leftwards so none collide vertically. */
function place(notes: SpelledNote[], y: (step: number) => number): Placed[] {
  const placed: Placed[] = []
  let prev: Placed | null = null
  for (const note of notes) {
    const shifted: boolean = !!prev && note.step - prev.note.step === 1 && prev.x === NOTE_X
    const p: Placed = { note, x: shifted ? NOTE_X + SECOND_DX : NOTE_X, y: y(note.step), accX: 0 }
    placed.push(p)
    prev = p
  }
  const columns: number[][] = []
  for (const p of [...placed].reverse()) {
    if (!p.note.accidental) continue
    let col = 0
    while (columns[col]?.some((s) => Math.abs(s - p.note.step) < 6)) col++
    ;(columns[col] ??= []).push(p.note.step)
    p.accX = NOTE_X - ACC_DX - col * ACC_COL
  }
  return placed
}

/** Steps of the ledger lines a note needs outside a staff whose lines span [bottom, top]. */
function ledgers(step: number, bottom: number, top: number): number[] {
  const out: number[] = []
  for (let s = bottom - 2; s >= step; s -= 2) out.push(s)
  for (let s = top + 2; s <= step; s += 2) out.push(s)
  return out
}

function Notes({ placed, y, bottom, top, color }: { placed: Placed[]; y: (s: number) => number; bottom: number; top: number; color: string }) {
  return (
    <>
      {placed.map((p) =>
        ledgers(p.note.step, bottom, top).map((s) => (
          <line
            key={`${p.note.midi}-l${s}`}
            x1={Math.min(p.x, NOTE_X) - 6.5}
            x2={Math.max(p.x, NOTE_X) + 6.5}
            y1={y(s)}
            y2={y(s)}
            stroke="currentColor"
            strokeOpacity={0.6}
            strokeWidth={0.9}
          />
        )),
      )}
      {placed.map((p) => (
        <path key={p.note.midi} d={wholeNote(p.x, p.y)} fill={color} fillRule="evenodd" />
      ))}
      {placed.map(
        (p) =>
          p.note.accidental !== 0 && (
            <text
              key={`${p.note.midi}-a`}
              x={p.accX}
              y={p.y}
              fontSize={21}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity={0.85}
              style={{ fontFamily: '"Noto Music"' }}
            >
              {ACCIDENTAL_GLYPH[p.note.accidental]}
            </text>
          ),
      )}
    </>
  )
}

/** Grand staff with the chord as whole notes: right hand in the treble clef, bass note in the bass clef. */
export const StaffChart = memo(function StaffChart({
  chord,
  color,
  height,
  title,
}: {
  chord: StaffChord
  color: string
  height: number
  title: string
}) {
  const treble = place(chord.treble, trebleY)
  const bass = place([chord.bass], bassY)
  const lines = [0, 1, 2, 3, 4]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={(height * W) / H} height={height} role="img" aria-label={title} className="block shrink-0 text-muted">
      {lines.map((i) => (
        <line key={`t${i}`} x1={2} x2={W - 2} y1={TREBLE_TOP + i * 6} y2={TREBLE_TOP + i * 6} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.8} />
      ))}
      {lines.map((i) => (
        <line key={`b${i}`} x1={2} x2={W - 2} y1={BASS_TOP + i * 6} y2={BASS_TOP + i * 6} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.8} />
      ))}
      <line x1={2} x2={2} y1={TREBLE_TOP} y2={BASS_TOP + 24} stroke="currentColor" strokeOpacity={0.6} strokeWidth={1.1} />
      <line x1={W - 2} x2={W - 2} y1={TREBLE_TOP} y2={BASS_TOP + 24} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.8} />
      <g fill="currentColor" fillOpacity={0.8} style={{ fontFamily: '"Noto Music"' }} aria-hidden>
        <text x={5} y={trebleY(32)} fontSize={24}>
          {'\u{1D11E}'}
        </text>
        <text x={5} y={bassY(24)} fontSize={24}>
          {'\u{1D122}'}
        </text>
      </g>
      <Notes placed={treble} y={trebleY} bottom={30} top={38} color={color} />
      <Notes placed={bass} y={bassY} bottom={18} top={26} color={color} />
    </svg>
  )
})
