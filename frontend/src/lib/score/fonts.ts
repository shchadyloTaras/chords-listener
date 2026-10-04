// The text font of the score (screen and PDF): DejaVu Serif (Bitstream Vera / DejaVu licence, see
// fonts/LICENSE-DejaVu.txt), subset to Latin, Cyrillic, Greek, punctuation and ♩ ♭ ♮ ♯ — so chord
// symbols get real ♭ / ♯ glyphs and Ukrainian titles render the same in the browser and in the PDF.
// Imported by lazy chunks only.

import serifUrl from './fonts/DejaVuSerif-subset.ttf?url'
import serifBoldUrl from './fonts/DejaVuSerif-Bold-subset.ttf?url'

/** Font family name used by OSMD (and registered in the PDF). */
export const SCORE_FONT = 'ScoreSerif'

export interface ScoreFontFiles {
  regular: ArrayBuffer
  bold: ArrayBuffer
}

let files: Promise<ScoreFontFiles> | null = null

async function fetchFont(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`font ${url}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

/** The TTF files (for jsPDF). */
export function scoreFontFiles(): Promise<ScoreFontFiles> {
  files ??= Promise.all([fetchFont(serifUrl), fetchFont(serifBoldUrl)]).then(([regular, bold]) => ({ regular, bold }))
  files.catch(() => (files = null))
  return files
}

let registered: Promise<boolean> | null = null

/**
 * Makes the font available to the page (OSMD measures and draws its text with it). Resolves false when
 * it cannot be loaded — the score then uses the browser's serif font.
 */
export function registerScoreFont(): Promise<boolean> {
  registered ??= (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return false
    try {
      const faces = [
        new FontFace(SCORE_FONT, `url(${serifUrl}) format('truetype')`, { weight: '400', style: 'normal' }),
        new FontFace(SCORE_FONT, `url(${serifBoldUrl}) format('truetype')`, { weight: '700', style: 'normal' }),
      ]
      await Promise.all(faces.map((f) => f.load()))
      for (const f of faces) document.fonts.add(f)
      return true
    } catch {
      return false
    }
  })()
  registered.then((ok) => {
    if (!ok) registered = null
  })
  return registered
}

/** OSMD's default text font when the score font cannot be loaded (OSMD takes one family name only). */
export const FALLBACK_FONT = 'Times New Roman'
