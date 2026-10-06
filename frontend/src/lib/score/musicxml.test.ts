// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { demoSong } from './__fixtures__/song'
import { buildScore, type ScoreInput } from './build'
import { toMusicXml } from './musicxml'
import type { NoteRow } from './vocal'

const LABELS = { vocal: 'Вокал', vocalAbbr: 'Вок.', piano: 'Фортепіано', pianoAbbr: 'Фп.', credit: 'Транскрипція: Chords Listener' }

function demoInput(over: Partial<ScoreInput> = {}): ScoreInput {
  const song = demoSong()
  return {
    title: 'Пісня «Тест» & Co',
    artist: 'Гурт <Тест>',
    key: { tonic: 'A', mode: 'minor', name: 'Am' },
    keyName: 'Am',
    transpose: 0,
    accidentals: 'auto',
    tempo: 100,
    timeSignature: 4,
    bars: song.bars,
    piano: song.piano,
    pianoSource: 'instruments',
    vocals: song.vocals,
    options: { vocals: true, piano: true, chords: true, level: 'full' },
    labels: LABELS,
    ...over,
  }
}

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error(err.textContent ?? 'XML parse error')
  return doc
}

const kids = (el: Element, name: string) => Array.from(el.children).filter((c) => c.tagName === name)
const kid = (el: Element, name: string) => kids(el, name)[0]
const textOf = (el: Element | undefined, name: string) => (el ? kid(el, name)?.textContent : undefined)

/** Every voice of every measure adds up to the measure length (walking notes, chords and backups). */
function checkDurations(doc: Document, lengths: number[]): void {
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    kids(part, 'measure').forEach((measure, mi) => {
      let pos = 0
      for (const el of Array.from(measure.children)) {
        if (el.tagName === 'note') {
          if (!kid(el, 'chord')) pos += Number(textOf(el, 'duration'))
        } else if (el.tagName === 'backup') {
          expect(pos, `${part.getAttribute('id')} m${mi} before backup`).toBe(lengths[mi])
          pos -= Number(textOf(el, 'duration'))
        }
      }
      expect(pos, `${part.getAttribute('id')} m${mi}`).toBe(lengths[mi])
    })
  }
}

describe('toMusicXml', () => {
  const score = buildScore(demoInput())
  const xml = toMusicXml(score, { date: '2026-10-04' })
  const doc = parse(xml)
  const root = doc.documentElement

  it('is a well-formed MusicXML 4.0 partwise document', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true)
    expect(xml).toContain('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"')
    expect(root.tagName).toBe('score-partwise')
    expect(root.getAttribute('version')).toBe('4.0')
    // header order required by the schema
    const order = Array.from(root.children).map((c) => c.tagName)
    expect(order.slice(0, 4)).toEqual(['work', 'identification', 'defaults', 'credit'])
    expect(order.indexOf('part-list')).toBeLessThan(order.indexOf('part'))
  })

  it('has the title, the artist and the transcription credit (escaped)', () => {
    expect(doc.getElementsByTagName('work-title')[0].textContent).toBe('Пісня «Тест» & Co')
    const creator = doc.getElementsByTagName('creator')[0]
    expect(creator.getAttribute('type')).toBe('composer')
    expect(creator.textContent).toBe('Гурт <Тест>')
    const credits = Array.from(doc.getElementsByTagName('credit')).map((c) => [textOf(c, 'credit-type'), textOf(c, 'credit-words')])
    expect(credits).toEqual([
      ['title', 'Пісня «Тест» & Co'],
      ['subtitle', 'Транскрипція: Chords Listener'],
      ['composer', 'Гурт <Тест>'],
    ])
  })

  it('has a vocal part and a piano grand staff', () => {
    const parts = Array.from(doc.getElementsByTagName('score-part'))
    expect(parts.map((p) => textOf(p, 'part-name'))).toEqual(['Вокал', 'Фортепіано'])
    const [vocal, piano] = Array.from(doc.getElementsByTagName('part'))
    const vAttrs = kid(kid(vocal, 'measure'), 'attributes')
    const pAttrs = kid(kid(piano, 'measure'), 'attributes')
    for (const a of [vAttrs, pAttrs]) {
      expect(textOf(a, 'divisions')).toBe('4')
      expect(textOf(kid(a, 'key'), 'fifths')).toBe('0')
      expect(textOf(kid(a, 'key'), 'mode')).toBe('minor')
      expect(textOf(kid(a, 'time'), 'beats')).toBe('4')
      expect(textOf(kid(a, 'time'), 'beat-type')).toBe('4')
    }
    expect(kids(vAttrs, 'clef').map((c) => [textOf(c, 'sign'), textOf(c, 'line')])).toEqual([['G', '2']])
    expect(textOf(pAttrs, 'staves')).toBe('2')
    expect(kids(pAttrs, 'clef').map((c) => [c.getAttribute('number'), textOf(c, 'sign'), textOf(c, 'line')])).toEqual([
      ['1', 'G', '2'],
      ['2', 'F', '4'],
    ])
    expect(kids(vocal, 'measure')).toHaveLength(4)
    expect(kids(piano, 'measure')).toHaveLength(4)
  })

  it('every measure of every voice adds up', () => {
    checkDurations(doc, score.map.measures.map((m) => m.ticks))
  })

  it('has the tempo marking and chord symbols above the vocal part', () => {
    const metronome = doc.getElementsByTagName('metronome')[0]
    expect(textOf(metronome, 'beat-unit')).toBe('quarter')
    expect(textOf(metronome, 'per-minute')).toBe('100')
    expect(doc.getElementsByTagName('sound')[0].getAttribute('tempo')).toBe('100')
    const [vocal, piano] = Array.from(doc.getElementsByTagName('part'))
    const roots = Array.from(vocal.getElementsByTagName('harmony')).map((h) => [
      textOf(kid(h, 'root'), 'root-step'),
      kid(h, 'kind').textContent,
    ])
    expect(roots).toEqual([
      ['A', 'minor'],
      ['F', 'major'],
      ['C', 'major'],
      ['G', 'major'],
    ])
    expect(piano.getElementsByTagName('harmony')).toHaveLength(0)
  })

  it('ties come in pairs and the held vocal note crosses the barline', () => {
    const ties = Array.from(doc.getElementsByTagName('tie'))
    const starts = ties.filter((t) => t.getAttribute('type') === 'start').length
    const stops = ties.filter((t) => t.getAttribute('type') === 'stop').length
    expect(starts).toBeGreaterThan(0)
    expect(starts).toBe(stops)
    const vocal = doc.getElementsByTagName('part')[0]
    const m2 = kids(vocal, 'measure')[1]
    const last = kids(m2, 'note').at(-1) as Element
    expect(textOf(kid(last, 'pitch'), 'step')).toBe('E')
    expect(kids(last, 'tie').map((t) => t.getAttribute('type'))).toEqual(['start'])
  })

  it('writes beams, dots and the dotted-eighth + sixteenth figure', () => {
    const vocal = doc.getElementsByTagName('part')[0]
    const m3 = kids(vocal, 'measure')[2]
    const notes = kids(m3, 'note').filter((n) => !kid(n, 'rest'))
    const g = notes.find((n) => textOf(kid(n, 'pitch'), 'step') === 'G') as Element
    expect(textOf(g, 'type')).toBe('eighth')
    expect(kids(g, 'dot')).toHaveLength(1)
    expect(kids(g, 'beam').map((b) => b.textContent)).toEqual(['begin'])
    const a = notes[notes.indexOf(g) + 1]
    expect(textOf(a, 'type')).toBe('16th')
    expect(kids(a, 'beam').map((b) => b.textContent)).toEqual(['end', 'backward hook'])
  })

  it('prints accidentals once per measure and cancels them with a natural', () => {
    const vocals: NoteRow[] = [
      [0, 0.6, 68, 0.8], // G#4
      [0.6, 1.2, 68, 0.8], // G#4 again: no sign
      [1.2, 1.8, 67, 0.8], // G4: natural
      [2.4, 3, 68, 0.8], // next measure: G#4 needs its sign again
    ]
    const d = parse(toMusicXml(buildScore(demoInput({ vocals, piano: null })), { date: '2026-10-04' }))
    const part = d.getElementsByTagName('part')[0]
    const accs = kids(part, 'measure').map((m) => kids(m, 'note').filter((n) => kid(n, 'pitch')).map((n) => textOf(n, 'accidental') ?? '-'))
    expect(accs[0]).toEqual(['sharp', '-', 'natural'])
    expect(accs[1][0]).toBe('sharp')
  })

  it('spells notes in the key and writes a low voice in the treble-8vb clef', () => {
    const vocals: NoteRow[] = [
      [0, 0.6, 46, 0.8], // B♭2 in F major
      [0.6, 1.2, 50, 0.8],
      [1.2, 2.4, 53, 0.8],
    ]
    const d = parse(
      toMusicXml(buildScore(demoInput({ vocals, piano: null, key: { tonic: 'F', mode: 'major', name: 'F' }, keyName: 'F' })), { date: '2026-10-04' }),
    )
    const clef = d.getElementsByTagName('clef')[0]
    expect(textOf(clef, 'sign')).toBe('G')
    expect(textOf(clef, 'clef-octave-change')).toBe('-1')
    expect(textOf(d.getElementsByTagName('key')[0], 'fifths')).toBe('-1')
    const first = d.getElementsByTagName('pitch')[0]
    expect([textOf(first, 'step'), textOf(first, 'alter'), textOf(first, 'octave')]).toEqual(['B', '-1', '2'])
    // B♭ is in the key signature: no accidental printed
    expect(textOf(first.parentElement as Element, 'accidental')).toBeUndefined()
  })

  it('writes a pickup as an implicit measure 0 and odd bars with a time change', () => {
    const song = demoSong()
    const bars = song.bars.map((b) => ({ ...b }))
    // make the first bar a 2-beat pickup
    bars[0] = { ...bars[0], pickup: true, boundaries: bars[0].boundaries.slice(2), start: bars[0].boundaries[2] }
    bars[0].boundaries = [0, bars[0].boundaries[0] / 2, bars[0].boundaries[0]]
    const s = buildScore(demoInput({ bars }))
    const d = parse(toMusicXml(s, { date: '2026-10-04' }))
    const measures = kids(d.getElementsByTagName('part')[0], 'measure')
    expect(measures[0].getAttribute('number')).toBe('0')
    expect(measures[0].getAttribute('implicit')).toBe('yes')
    expect(textOf(kid(kid(measures[0], 'attributes'), 'time'), 'beats')).toBe('4')
    checkDurations(d, s.map.measures.map((m) => m.ticks))
  })

  it('only the requested parts; chord symbols move to the piano without vocals', () => {
    const d = parse(toMusicXml(buildScore(demoInput({ options: { vocals: false, piano: true, chords: true, level: 'medium' } })), { date: '2026-10-04' }))
    const parts = Array.from(d.getElementsByTagName('score-part'))
    expect(parts.map((p) => textOf(p, 'part-name'))).toEqual(['Фортепіано'])
    const harmony = d.getElementsByTagName('harmony')[0]
    expect(textOf(harmony, 'staff')).toBe('1')
    // the medium level: no sixteenths
    expect(Array.from(d.getElementsByTagName('type')).some((t) => t.textContent === '16th')).toBe(false)
  })

  it('the simple level writes the chord sheet as whole notes on the piano staves', () => {
    const s = buildScore(demoInput({ piano: null, pianoSource: null, options: { vocals: false, piano: true, chords: true, level: 'simple' } }))
    const d = parse(toMusicXml(s, { date: '2026-10-04' }))
    expect(Array.from(d.getElementsByTagName('score-part')).map((p) => textOf(p, 'part-name'))).toEqual(['Фортепіано'])
    const notes = Array.from(d.getElementsByTagName('note'))
    expect(notes.length).toBeGreaterThan(0)
    expect(new Set(notes.map((n) => textOf(n, 'type')))).toEqual(new Set(['whole']))
    expect(notes.some((n) => kid(n, 'rest') || kid(n, 'tie'))).toBe(false)
    // bar 1, Am: A4 C5 E5 in the right hand, A3 in the left
    const m1 = kids(d.getElementsByTagName('part')[0], 'measure')[0]
    const pitch = (n: Element) => [textOf(kid(n, 'pitch'), 'step'), textOf(kid(n, 'pitch'), 'octave'), textOf(n, 'staff')]
    expect(kids(m1, 'note').map(pitch)).toEqual([
      ['A', '4', '1'],
      ['C', '5', '1'],
      ['E', '5', '1'],
      ['A', '3', '2'],
    ])
    expect(Array.from(d.getElementsByTagName('harmony')).map((h) => textOf(kid(h, 'root'), 'root-step'))).toEqual(['A', 'F', 'C', 'G'])
    checkDurations(d, s.map.measures.map((m) => m.ticks))
  })

  it('matches the stored fixture', async () => {
    await expect(xml).toMatchFileSnapshot('./__fixtures__/demo.musicxml')
  })

  it('loads in OpenSheetMusicDisplay', async () => {
    // jsdom has no canvas: OSMD only needs text widths while building its graphical sheet
    const fake = {
      font: '10px serif',
      measureText(s: string) {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10)
        return { width: s.length * px * 0.55 }
      },
    }
    HTMLCanvasElement.prototype.getContext = (() => fake) as unknown as HTMLCanvasElement['getContext']
    const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay')
    const div = document.createElement('div')
    document.body.appendChild(div)
    const osmd = new OpenSheetMusicDisplay(div, { backend: 'svg', autoResize: false })
    osmd.setLogLevel('error')
    await osmd.load(xml)
    expect(osmd.Sheet.SourceMeasures).toHaveLength(4)
    expect(osmd.Sheet.Instruments.map((i) => i.Name)).toEqual(['Вокал', 'Фортепіано'])
    expect(osmd.Sheet.Instruments[1].Staves).toHaveLength(2)
    expect(osmd.Sheet.TitleString).toBe('Пісня «Тест» & Co')
  })
})
