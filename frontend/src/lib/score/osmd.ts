// OpenSheetMusicDisplay (BSD-3-Clause, https://opensheetmusicdisplay.org) setup shared by the score
// view and the PDF export, plus the geometry the view needs for its playback cursor and click-to-seek.
// Imported only from lazy chunks: OSMD (with VexFlow) never lands in the main bundle.

import { ChordSymbolEnum, OpenSheetMusicDisplay, type IOSMDOptions } from 'opensheetmusicdisplay'
import { DIV, type TimeMap } from './timeMap'

export { OpenSheetMusicDisplay }

export interface ScoreColors {
  /** notes, staff lines, labels */
  ink: string
  /** chord symbols */
  chords: string
}

export const PAPER_COLORS: ScoreColors = { ink: '#111111', chords: '#111111' }

/** Options common to the screen and the PDF. */
export function baseOptions(colors: ScoreColors): IOSMDOptions {
  return {
    backend: 'svg',
    autoResize: false,
    autoBeam: false,
    disableCursor: true,
    followCursor: false,
    drawPartNames: true,
    drawPartAbbreviations: true,
    drawMeasureNumbers: true,
    drawMeasureNumbersOnlyAtSystemStart: true,
    drawMetronomeMarks: true,
    drawLyricist: false,
    drawFingerings: false,
    autoGenerateMultipleRestMeasuresFromRestMeasures: false,
    defaultColorMusic: colors.ink,
    defaultColorNotehead: colors.ink,
    defaultColorStem: colors.ink,
    defaultColorRest: colors.ink,
    defaultColorLabel: colors.ink,
    defaultColorTitle: colors.ink,
  }
}

/** Engraving details that must be set before load(): ♯ / ♭ in chord symbols, "6" for sixth chords. */
export function configureRules(osmd: OpenSheetMusicDisplay, colors: ScoreColors): void {
  const rules = osmd.EngravingRules
  rules.resetChordAccidentalTexts(rules.ChordAccidentalTexts, true)
  rules.resetChordSymbolLabelTexts(rules.ChordSymbolLabelTexts)
  rules.setChordSymbolLabelText(ChordSymbolEnum.majorsixth, '6')
  rules.setChordSymbolLabelText(ChordSymbolEnum.augmented, 'aug')
  rules.DefaultColorChordSymbol = colors.chords
  rules.RenderChordSymbols = true
}

// ------------------------------------------------------------------ geometry (screen)

export interface MeasureBox {
  /** measure index (= bar index) */
  index: number
  /** container px */
  left: number
  right: number
  top: number
  bottom: number
  /** where notes start (after clef / key / time) */
  noteLeft: number
  /** x of the written notes by their position in the measure (fraction 0..1), ascending */
  anchors: { frac: number; x: number }[]
}

export interface ScoreLayout {
  measures: (MeasureBox | undefined)[]
}

interface Pos {
  x: number
  y: number
}
interface Box {
  AbsolutePosition: Pos
  BorderLeft: number
  BorderRight: number
}
interface StaffEntryLike {
  relInMeasureTimestamp: { RealValue: number }
  PositionAndShape: Box
}
interface MeasureLike {
  PositionAndShape: Box
  staffEntries: StaffEntryLike[]
  beginInstructionsWidth: number
  ParentMusicSystem?: { StaffLines: { PositionAndShape: Box }[] }
  IsExtraGraphicalMeasure?: boolean
}

/**
 * Measure boxes in container pixels. `origin` is the SVG's offset inside the container; OSMD units are
 * 10 px × zoom.
 */
export function measureLayout(osmd: OpenSheetMusicDisplay, map: TimeMap, origin: Pos): ScoreLayout {
  const unit = 10 * osmd.Zoom
  const px = (u: number) => u * unit
  const list = (osmd.GraphicSheet?.MeasureList ?? []) as unknown as (MeasureLike | undefined)[][]
  const measures: (MeasureBox | undefined)[] = []
  for (let mi = 0; mi < list.length; mi++) {
    const staves = (list[mi] ?? []).filter((g): g is MeasureLike => !!g && !g.IsExtraGraphicalMeasure)
    const first = staves[0]
    const m = map.measures[mi]
    if (!first || !m) {
      measures.push(undefined)
      continue
    }
    const box = first.PositionAndShape
    const left = origin.x + px(box.AbsolutePosition.x + box.BorderLeft)
    const right = origin.x + px(box.AbsolutePosition.x + box.BorderRight)
    const lines = first.ParentMusicSystem?.StaffLines ?? []
    const topLine = lines[0]?.PositionAndShape.AbsolutePosition.y ?? 0
    const bottomLine = (lines[lines.length - 1]?.PositionAndShape.AbsolutePosition.y ?? topLine) + 4
    const top = origin.y + px(topLine - 3.5)
    const bottom = origin.y + px(bottomLine + 2.5)
    const byFrac = new Map<number, number[]>()
    for (const gm of staves) {
      for (const se of gm.staffEntries ?? []) {
        const frac = Math.min(1, Math.max(0, (se.relInMeasureTimestamp.RealValue * 4 * DIV) / m.ticks))
        const k = Math.round(frac * 4096) / 4096
        const xs = byFrac.get(k)
        const x = origin.x + px(se.PositionAndShape.AbsolutePosition.x)
        if (xs) xs.push(x)
        else byFrac.set(k, [x])
      }
    }
    const anchors = [...byFrac.entries()]
      .map(([frac, xs]) => ({ frac, x: xs.reduce((a, b) => a + b, 0) / xs.length }))
      .sort((a, b) => a.frac - b.frac)
    const noteLeft = anchors.length && anchors[0].frac === 0 ? anchors[0].x : left + px(first.beginInstructionsWidth ?? 0) + 6
    if (!anchors.length || anchors[0].frac > 0) anchors.unshift({ frac: 0, x: noteLeft })
    anchors.push({ frac: 1, x: right - 4 })
    measures.push({ index: mi, left, right, top, bottom, noteLeft, anchors })
  }
  return { measures }
}

/** x of a fraction of the measure (linear between the written notes). */
export function xAt(box: MeasureBox, frac: number): number {
  const a = box.anchors
  const f = Math.min(1, Math.max(0, frac))
  for (let i = 1; i < a.length; i++) {
    if (f <= a[i].frac) {
      const span = a[i].frac - a[i - 1].frac
      const k = span > 0 ? (f - a[i - 1].frac) / span : 0
      return a[i - 1].x + k * (a[i].x - a[i - 1].x)
    }
  }
  return a[a.length - 1].x
}

/** Fraction of the measure under x; snapped to a written note within `snapPx`. */
export function fracAt(box: MeasureBox, x: number, snapPx = 14): number {
  const a = box.anchors
  let best = -1
  let bestD = snapPx
  for (let i = 0; i < a.length - 1; i++) {
    const d = Math.abs(a[i].x - x)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  if (best >= 0) return a[best].frac
  if (x <= a[0].x) return 0
  for (let i = 1; i < a.length; i++) {
    if (x <= a[i].x) {
      const span = a[i].x - a[i - 1].x
      return a[i - 1].frac + (span > 0 ? (x - a[i - 1].x) / span : 0) * (a[i].frac - a[i - 1].frac)
    }
  }
  return 1
}
