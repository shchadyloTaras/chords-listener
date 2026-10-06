// Score → MusicXML 4.0 (score-partwise): header with work title, artist, transcription credit and an
// A4 page layout; part "Вокал" (treble or treble-8vb clef, chord symbols above it) and part
// "Фортепіано" (grand staff, G and F clefs); key, time (incl. pickup / odd bars), tempo; written notes
// with ties, dots, explicit accidentals and beams. Readable by OpenSheetMusicDisplay and MuseScore.

import { harmonyOf } from './chordSymbols'
import { keyAlter, spellMidi, type Step } from './spelling'
import { DIV } from './timeMap'
import type { Clef, Part, Score, WrittenNote } from './types'

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
  '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'

/** A4 portrait in tenths (7 mm staff height = 40 tenths). */
const PAGE = { width: 1200, height: 1697, margin: 85 }

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] as string)
}

/** Strips characters XML 1.0 does not allow (control characters from odd metadata). */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
}

const text = (s: string) => escapeXml(clean(s))

class Out {
  private readonly lines: string[] = []
  private depth = 0
  open(tag: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}<${tag}>`)
    this.depth++
  }
  close(name: string): void {
    this.depth--
    this.lines.push(`${'  '.repeat(this.depth)}</${name}>`)
  }
  line(s: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${s}`)
  }
  toString(): string {
    return this.lines.join('\n') + '\n'
  }
}

function clefXml(clef: Clef, number?: number): string {
  const n = number ? ` number="${number}"` : ''
  switch (clef) {
    case 'bass':
      return `<clef${n}><sign>F</sign><line>4</line></clef>`
    case 'treble8vb':
      return `<clef${n}><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`
    default:
      return `<clef${n}><sign>G</sign><line>2</line></clef>`
  }
}

const ACCIDENTAL: Record<number, string> = { [-2]: 'flat-flat', [-1]: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' }

function stepAlter(tag: 'root' | 'bass', p: { step: Step; alter: number }): string {
  const alter = p.alter ? `<${tag}-alter>${p.alter}</${tag}-alter>` : ''
  return `<${tag}><${tag}-step>${p.step}</${tag}-step>${alter}</${tag}>`
}

function harmonyXml(out: Out, label: string, staff: number | null): void {
  const st = staff ? `<staff>${staff}</staff>` : ''
  const h = label === 'N' ? null : harmonyOf(label)
  if (!h) {
    if (label !== 'N') return
    out.line(`<harmony print-frame="no"><root><root-step text="">C</root-step></root><kind text="N.C.">none</kind>${st}</harmony>`)
    return
  }
  const degrees = h.degrees
    .map((d) => `<degree><degree-value>${d.value}</degree-value><degree-alter>${d.alter}</degree-alter><degree-type>${d.type}</degree-type></degree>`)
    .join('')
  const bass = h.bass ? stepAlter('bass', h.bass) : ''
  out.line(`<harmony print-frame="no">${stepAlter('root', h.root)}<kind text="${escapeXml(h.text)}">${h.kind}</kind>${bass}${degrees}${st}</harmony>`)
}

/** Measure-local accidental state of one staff (letter + octave → alteration in force). */
class Accidentals {
  private readonly state = new Map<string, number>()
  private readonly fifths: number
  constructor(fifths: number) {
    this.fifths = fifths
  }
  /** The accidental to print for a pitch (null = none), updating the state. */
  next(step: Step, octave: number, alter: number, tied: boolean): string | null {
    const k = `${step}${octave}`
    const current = this.state.get(k) ?? keyAlter(step, this.fifths)
    if (tied) return null
    if (current === alter) return null
    this.state.set(k, alter)
    return ACCIDENTAL[alter] ?? null
  }
}

function noteXml(out: Out, w: WrittenNote, opts: { voice: number; staff: number | null; acc: Accidentals; score: Score }): void {
  const staff = opts.staff ? `<staff>${opts.staff}</staff>` : ''
  if (!w.pitches.length) {
    out.open('note')
    out.line(w.measureRest ? '<rest measure="yes"/>' : '<rest/>')
    out.line(`<duration>${w.duration}</duration>`)
    out.line(`<voice>${opts.voice}</voice>`)
    if (w.type) out.line(`<type>${w.type}</type>`)
    for (let d = 0; d < w.dots; d++) out.line('<dot/>')
    if (staff) out.line(staff)
    out.close('note')
    return
  }
  w.pitches.forEach((midi, i) => {
    // the note's own spelling (a chord of the simple level), else from the key
    const p = w.spelling?.[i] ?? spellMidi(midi, opts.score.key)
    const acc = opts.acc.next(p.step, p.octave, p.alter, w.tieStop)
    out.open('note')
    if (i > 0) out.line('<chord/>')
    out.line(`<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>`)
    out.line(`<duration>${w.duration}</duration>`)
    if (w.tieStop) out.line('<tie type="stop"/>')
    if (w.tieStart) out.line('<tie type="start"/>')
    out.line(`<voice>${opts.voice}</voice>`)
    if (w.type) out.line(`<type>${w.type}</type>`)
    for (let d = 0; d < w.dots; d++) out.line('<dot/>')
    if (acc) out.line(`<accidental>${acc}</accidental>`)
    if (staff) out.line(staff)
    if (i === 0) w.beams.forEach((b, level) => out.line(`<beam number="${level + 1}">${b}</beam>`))
    if (w.tieStop || w.tieStart) {
      out.line(`<notations>${w.tieStop ? '<tied type="stop"/>' : ''}${w.tieStart ? '<tied type="start"/>' : ''}</notations>`)
    }
    out.close('note')
  })
}

export interface MusicXmlOptions {
  /** encoding date (YYYY-MM-DD), default today */
  date?: string
  /** software name in <encoding> */
  software?: string
}

function partXml(out: Out, score: Score, part: Part, pi: number, first: boolean): void {
  const { map, key, meta } = score
  const ts = map.timeSignature
  const multi = part.staves.length > 1
  out.open(`part id="P${pi + 1}"`)
  let beats = ts
  map.measures.forEach((m, mi) => {
    const attrs = [`number="${m.number}"`]
    if (m.pickup) attrs.push('implicit="yes"')
    out.open(`measure ${attrs.join(' ')}`)
    const shown = m.pickup ? ts : m.beats
    const time = mi === 0 || shown !== beats ? `<time><beats>${shown}</beats><beat-type>4</beat-type></time>` : ''
    beats = shown
    if (mi === 0) {
      out.open('attributes')
      out.line(`<divisions>${DIV}</divisions>`)
      out.line(`<key><fifths>${key.fifths}</fifths>${key.known ? `<mode>${key.mode}</mode>` : ''}</key>`)
      out.line(time)
      if (multi) out.line(`<staves>${part.staves.length}</staves>`)
      part.staves.forEach((s, si) => out.line(clefXml(s.clef, multi ? si + 1 : undefined)))
      out.close('attributes')
      if (first && meta.tempo) {
        out.open('direction placement="above"')
        out.line(
          `<direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${meta.tempo}</per-minute></metronome></direction-type>`,
        )
        if (multi) out.line('<staff>1</staff>')
        out.line(`<sound tempo="${meta.tempo}"/>`)
        out.close('direction')
      }
    } else if (time) {
      out.open('attributes')
      out.line(time)
      out.close('attributes')
    }
    part.staves.forEach((staff, si) => {
      if (si > 0) out.line(`<backup><duration>${m.ticks}</duration></backup>`)
      const acc = new Accidentals(key.fifths)
      const voice = si * 4 + 1
      for (const w of staff.measures[mi] ?? []) {
        if (w.harmony !== undefined) harmonyXml(out, w.harmony, multi ? si + 1 : null)
        noteXml(out, w, { voice, staff: multi ? si + 1 : null, acc, score })
      }
    })
    if (mi === map.measures.length - 1) out.line('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
    out.close('measure')
  })
  out.close('part')
}

/** The whole score as a MusicXML 4.0 partwise document. */
export function toMusicXml(score: Score, opts: MusicXmlOptions = {}): string {
  if (!score.parts.length) throw new Error('The score has no parts')
  const out = new Out()
  const { meta } = score
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  out.open('score-partwise version="4.0"')
  out.line(`<work><work-title>${text(meta.title)}</work-title></work>`)
  out.open('identification')
  if (meta.artist) out.line(`<creator type="composer">${text(meta.artist)}</creator>`)
  out.open('encoding')
  out.line(`<software>${text(opts.software ?? 'Chords Listener')}</software>`)
  out.line(`<encoding-date>${date}</encoding-date>`)
  out.line('<supports element="accidental" type="yes"/>')
  out.line('<supports element="beam" type="yes"/>')
  out.line('<supports element="print" attribute="new-page" type="no"/>')
  out.line('<supports element="print" attribute="new-system" type="no"/>')
  out.line('<supports element="stem" type="no"/>')
  out.close('encoding')
  out.close('identification')
  out.open('defaults')
  out.line('<scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>')
  out.line(
    `<page-layout><page-height>${PAGE.height}</page-height><page-width>${PAGE.width}</page-width>` +
      `<page-margins type="both"><left-margin>${PAGE.margin}</left-margin><right-margin>${PAGE.margin}</right-margin>` +
      `<top-margin>${PAGE.margin}</top-margin><bottom-margin>${PAGE.margin}</bottom-margin></page-margins></page-layout>`,
  )
  out.close('defaults')
  const top = PAGE.height - PAGE.margin
  out.line(
    `<credit page="1"><credit-type>title</credit-type><credit-words default-x="${PAGE.width / 2}" default-y="${top}" justify="center" valign="top" font-size="22">${text(meta.title)}</credit-words></credit>`,
  )
  out.line(
    `<credit page="1"><credit-type>subtitle</credit-type><credit-words default-x="${PAGE.width / 2}" default-y="${top - 50}" justify="center" valign="top" font-size="10">${text(meta.credit)}</credit-words></credit>`,
  )
  if (meta.artist) {
    out.line(
      `<credit page="1"><credit-type>composer</credit-type><credit-words default-x="${PAGE.width - PAGE.margin}" default-y="${top - 90}" justify="right" valign="bottom" font-size="12">${text(meta.artist)}</credit-words></credit>`,
    )
  }
  out.open('part-list')
  score.parts.forEach((p, i) => {
    const id = `P${i + 1}`
    out.open(`score-part id="${id}"`)
    out.line(`<part-name>${text(p.name)}</part-name>`)
    out.line(`<part-abbreviation>${text(p.abbreviation)}</part-abbreviation>`)
    out.line(`<score-instrument id="${id}-I1"><instrument-name>${text(p.name)}</instrument-name></score-instrument>`)
    out.line(
      `<midi-instrument id="${id}-I1"><midi-channel>${i + 1}</midi-channel><midi-program>${p.program + 1}</midi-program><volume>80</volume><pan>0</pan></midi-instrument>`,
    )
    out.close('score-part')
  })
  out.close('part-list')
  score.parts.forEach((p, i) => partXml(out, score, p, i, i === 0))
  out.close('score-partwise')
  return XML_HEADER + out.toString()
}
