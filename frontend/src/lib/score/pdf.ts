// Score → PDF (A4 portrait, vector): OpenSheetMusicDisplay lays the MusicXML out on A4 pages as SVG,
// svg2pdf.js (MIT) draws each page into jsPDF (MIT) as vector paths and text. Text uses the embedded
// score font (lib/score/fonts: a DejaVu Serif subset with Cyrillic and ♩ ♭ ♮ ♯), so Ukrainian titles
// render on any PDF viewer (iPhone Files / Safari, Android, desktop). The same font is registered with
// the page while OSMD measures, so the layout matches what is printed. Loaded on demand only.

import { jsPDF } from 'jspdf'
import { svg2pdf } from 'svg2pdf.js'
import { registerScoreFont, SCORE_FONT as FAMILY, scoreFontFiles, type ScoreFontFiles } from './fonts'
import { escapeXml } from './musicxml'
import { baseOptions, configureRules, OpenSheetMusicDisplay, PAPER_COLORS } from './osmd'

/** A4 in points */
const PAGE_W = 595.28
const PAGE_H = 841.89
/** Layout width in px for an A4 page: 1100 px ≈ a 7.6 mm staff (comfortable to read and to print). */
const LAYOUT_WIDTH = 1100

export interface PdfInfo {
  title: string
  artist: string | null
  /** "Тональність: Am · ♩ = 96" — under the title on page 1 */
  details: string
  /** "Сторінка {n} з {total}" */
  pageLabel(n: number, total: number): string
  /** document properties */
  subject: string
  creator: string
  /** document language ("uk" | "en") */
  lang: string
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function addFonts(pdf: jsPDF, f: ScoreFontFiles): void {
  pdf.addFileToVFS('ScoreSerif-Regular.ttf', base64(f.regular))
  pdf.addFileToVFS('ScoreSerif-Bold.ttf', base64(f.bold))
  pdf.addFont('ScoreSerif-Regular.ttf', FAMILY, 'normal', 400, 'Identity-H')
  pdf.addFont('ScoreSerif-Regular.ttf', FAMILY, 'italic', 400, 'Identity-H')
  pdf.addFont('ScoreSerif-Bold.ttf', FAMILY, 'bold', 700, 'Identity-H')
  pdf.addFont('ScoreSerif-Bold.ttf', FAMILY, 'bolditalic', 700, 'Identity-H')
}

/**
 * Every text in the page SVG uses the embedded font, with a size svg2pdf understands (it reads px and
 * em only: VexFlow writes the tempo mark in pt); the SVG scales to the page (viewBox).
 */
function prepareSvg(svg: SVGElement): void {
  for (const el of Array.from(svg.querySelectorAll('text, tspan'))) {
    el.setAttribute('font-family', FAMILY)
    ;(el as SVGElement).style?.removeProperty('font-family')
    const size = /^([\d.]+)pt$/.exec(el.getAttribute('font-size') ?? '')
    if (size) el.setAttribute('font-size', `${(parseFloat(size[1]) * 4) / 3}px`)
  }
  if (!svg.getAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width') ?? '') || svg.clientWidth
    const h = parseFloat(svg.getAttribute('height') ?? '') || svg.clientHeight
    if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  }
}

/** Adds the key / tempo line as the "lyricist" text OSMD draws top left under the title. */
function withDetails(xml: string, details: string): string {
  if (!details) return xml
  return xml.replace('<identification>', `<identification>\n    <creator type="lyricist">${escapeXml(details)}</creator>`)
}

/** Renders the MusicXML to a PDF file. */
export async function scorePdf(xml: string, info: PdfInfo): Promise<Blob> {
  const f = await scoreFontFiles()
  await registerScoreFont()
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:fixed;left:-30000px;top:0;width:${LAYOUT_WIDTH}px;visibility:hidden;pointer-events:none;contain:layout`
  document.body.appendChild(host)
  try {
    const osmd = new OpenSheetMusicDisplay(host, {
      ...baseOptions(PAPER_COLORS),
      pageFormat: 'A4_P',
      pageBackgroundColor: '#FFFFFF',
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawLyricist: true,
      drawCredits: true,
      defaultFontFamily: FAMILY,
      autoGenerateMultipleRestMeasuresFromRestMeasures: true,
    })
    osmd.setLogLevel('warn')
    configureRules(osmd, PAPER_COLORS)
    await osmd.load(withDetails(xml, info.details))
    osmd.Zoom = 1
    osmd.render()
    const pages = osmd.Drawer.Backends.map((b) => (b as unknown as { getSvgElement(): SVGElement }).getSvgElement())
    if (!pages.length) throw new Error('OSMD produced no pages')

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true })
    addFonts(pdf, f)
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) pdf.addPage('a4', 'portrait')
      prepareSvg(pages[i])
      await svg2pdf(pages[i], pdf, { x: 0, y: 0, width: PAGE_W, height: PAGE_H })
      pdf.setFont(FAMILY, 'normal')
      pdf.setFontSize(8.5)
      pdf.setTextColor(120, 120, 120)
      pdf.text(info.pageLabel(i + 1, pages.length), PAGE_W / 2, PAGE_H - 22, { align: 'center' })
    }
    pdf.setProperties({
      title: info.title,
      author: info.artist ?? '',
      subject: info.subject,
      creator: info.creator,
      keywords: 'sheet music, MusicXML, Chords Listener',
    })
    pdf.setLanguage?.(info.lang === 'uk' ? 'uk' : 'en-US')
    return pdf.output('blob')
  } finally {
    host.remove()
  }
}
