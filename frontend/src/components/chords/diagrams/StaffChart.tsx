import '@fontsource/bravura'
import { memo } from 'react'
import type { SpelledNote, StaffNotes } from '../../../lib/diagrams/staff'

// Engraved with Bravura, a SMuFL font: a glyph's origin sits exactly on its reference line
// (the G clef's spiral on the G4 line, the F clef's head and dots around the F3 line), and
// 1 em = 4 staff spaces. Units below: one staff space = SP, a staff step (line → space) = SP / 2.
const SP = 6
const FONT = 4 * SP
const STEP = SP / 2
const TREBLE_TOP = 17 // y of the F5 line
const BASS_TOP = TREBLE_TOP + 4 * SP + 3.5 * SP // y of the A3 line
const W = 74
const H = BASS_TOP + 4 * SP + 9
/** height of the treble staff alone (one hand, no bass) */
const H_TREBLE = TREBLE_TOP + 4 * SP + 9
const CLEF_X = 4
const NOTE_X = 50 // notehead centre
const HEAD_W = 1.688 * SP // noteheadWhole width (Bravura metadata)
const LEDGER_EXT = 0.4 * SP // ledger line extension beyond the notehead
const ACC_GAP = 0.25 * SP // space between an accidental and its notehead
const ACC_COL = 1.3 * SP // shift for each extra accidental column

const trebleY = (step: number) => TREBLE_TOP + (38 - step) * STEP // F5 = step 38
const bassY = (step: number) => BASS_TOP + (26 - step) * STEP // A3 = step 26

const G_CLEF = ''
const F_CLEF = ''
const WHOLE_NOTE = ''
/** SMuFL accidental glyphs and their widths in staff spaces. */
const ACCIDENTAL: Record<number, { glyph: string; width: number }> = {
  [-2]: { glyph: '', width: 1.644 },
  [-1]: { glyph: '', width: 0.904 },
  1: { glyph: '', width: 0.996 },
  2: { glyph: '', width: 0.988 },
}

interface Placed {
  note: SpelledNote
  /** notehead centre */
  x: number
  y: number
  /** left edge of the accidental glyph */
  accX: number
}

/** Seconds displace the upper note to the right; accidentals stack leftwards so none collide. */
function place(notes: SpelledNote[], y: (step: number) => number): Placed[] {
  const placed: Placed[] = []
  let prev: Placed | null = null
  for (const note of notes) {
    const shifted: boolean = !!prev && note.step - prev.note.step === 1 && prev.x === NOTE_X
    const p: Placed = { note, x: shifted ? NOTE_X + HEAD_W : NOTE_X, y: y(note.step), accX: 0 }
    placed.push(p)
    prev = p
  }
  const columns: number[][] = []
  for (const p of [...placed].reverse()) {
    const acc = ACCIDENTAL[p.note.accidental]
    if (!acc) continue
    let col = 0
    while (columns[col]?.some((s) => Math.abs(s - p.note.step) < 6)) col++
    ;(columns[col] ??= []).push(p.note.step)
    p.accX = NOTE_X - HEAD_W / 2 - ACC_GAP - col * ACC_COL - acc.width * SP
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
            x1={Math.min(p.x, NOTE_X) - HEAD_W / 2 - LEDGER_EXT}
            x2={Math.max(p.x, NOTE_X) + HEAD_W / 2 + LEDGER_EXT}
            y1={y(s)}
            y2={y(s)}
            stroke="currentColor"
            strokeOpacity={0.6}
            strokeWidth={0.16 * SP}
          />
        )),
      )}
      {placed.map((p) => (
        <text key={p.note.midi} x={p.x - HEAD_W / 2} y={p.y} fontSize={FONT} fill={color}>
          {WHOLE_NOTE}
        </text>
      ))}
      {placed.map(
        (p) =>
          ACCIDENTAL[p.note.accidental] && (
            <text key={`${p.note.midi}-a`} x={p.accX} y={p.y} fontSize={FONT} fill="currentColor" fillOpacity={0.85}>
              {ACCIDENTAL[p.note.accidental].glyph}
            </text>
          ),
      )}
    </>
  )
}

/**
 * Grand staff with the chord as whole notes: right hand in the treble clef (G clef), bass note
 * in the bass clef (F clef). Without a bass note only the treble staff, at the same scale.
 */
export const StaffChart = memo(function StaffChart({
  chord,
  color,
  height,
  title,
  clefTitles,
}: {
  chord: StaffNotes
  color: string
  /** height of the grand staff; the treble staff alone keeps its scale */
  height: number
  title: string
  /** hover titles for the two clefs */
  clefTitles?: { treble: string; bass: string }
}) {
  const treble = place(chord.treble, trebleY)
  const bass = chord.bass ? place([chord.bass], bassY) : null
  const lines = [0, 1, 2, 3, 4]
  const h = bass ? H : H_TREBLE
  const bottom = bass ? BASS_TOP + 4 * SP : TREBLE_TOP + 4 * SP

  return (
    <svg
      viewBox={`0 0 ${W} ${h}`}
      width={(height * W) / H}
      height={(height * h) / H}
      role="img"
      aria-label={title}
      className="block shrink-0 text-muted"
      style={{ fontFamily: 'Bravura' }}
    >
      {lines.map((i) => (
        <line key={`t${i}`} x1={2} x2={W - 2} y1={TREBLE_TOP + i * SP} y2={TREBLE_TOP + i * SP} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.13 * SP} />
      ))}
      {bass &&
        lines.map((i) => (
          <line key={`b${i}`} x1={2} x2={W - 2} y1={BASS_TOP + i * SP} y2={BASS_TOP + i * SP} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.13 * SP} />
        ))}
      <line x1={2} x2={2} y1={TREBLE_TOP} y2={bottom} stroke="currentColor" strokeOpacity={0.6} strokeWidth={0.16 * SP} />
      <line x1={W - 2} x2={W - 2} y1={TREBLE_TOP} y2={bottom} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.13 * SP} />
      <g fill="currentColor" fillOpacity={0.85}>
        {/* G clef: origin on the G4 line (2nd line from the bottom of the treble staff) */}
        <text x={CLEF_X} y={trebleY(32)} fontSize={FONT}>
          {clefTitles && <title>{clefTitles.treble}</title>}
          {G_CLEF}
        </text>
        {/* F clef: origin on the F3 line (2nd line from the top of the bass staff) */}
        {bass && (
          <text x={CLEF_X} y={bassY(24)} fontSize={FONT}>
            {clefTitles && <title>{clefTitles.bass}</title>}
            {F_CLEF}
          </text>
        )}
      </g>
      <Notes placed={treble} y={trebleY} bottom={30} top={38} color={color} />
      {bass && <Notes placed={bass} y={bassY} bottom={18} top={26} color={color} />}
    </svg>
  )
})
