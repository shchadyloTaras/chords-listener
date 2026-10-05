// Colours for the canvas, read from the app's CSS tokens on <html> (src/index.css): pitch-class
// colours come from the chord palette (--chord-N around the circle of fifths), so a key lights in the
// same hue as chords rooted on that note. Canvas needs numbers, so CSS colours (oklch(), hex, rgb())
// are converted to sRGB here; anything else is resolved by the browser through a 1×1 canvas.

export type Rgb = readonly [number, number, number]

export interface Palette {
  dark: boolean
  /** --chord-0..11 by fifths index */
  chord: Rgb[]
  bg: Rgb
  surface: Rgb
  surface2: Rgb
  border: Rgb
  text: Rgb
  muted: Rgb
  faint: Rgb
  accent: Rgb
  keyWhite: Rgb
  keyBlack: Rgb
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const toByte = (x: number) => Math.round(clamp01(x) * 255)

function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/** OKLCH (L 0..1, C, H degrees) → sRGB bytes (clipped to the gamut). */
export function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const L = l_ ** 3
  const M = m_ ** 3
  const S = s_ ** 3
  const r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
  return [toByte(gammaEncode(r)), toByte(gammaEncode(g)), toByte(gammaEncode(bl))]
}

function num(token: string, percentScale = 1): number {
  const t = token.trim()
  if (t.endsWith('%')) return (parseFloat(t) / 100) * percentScale
  if (t.endsWith('deg')) return parseFloat(t)
  return parseFloat(t)
}

/** Parses the CSS colours our tokens use: #rgb / #rrggbb, rgb()/rgba(), oklch(). Null for others. */
export function parseCssColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase()
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1]
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const [r, g, b] = parts.slice(0, 3).map((p) => (p.endsWith('%') ? num(p, 255) : parseFloat(p)))
    if (![r, g, b].every(Number.isFinite)) return null
    return [Math.round(r), Math.round(g), Math.round(b)]
  }
  m = /^oklch\(([^)]+)\)$/.exec(v)
  if (m) {
    const parts = m[1].split(/[\s/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const l = num(parts[0])
    const c = num(parts[1], 0.4)
    const h = parts[2] === 'none' ? 0 : num(parts[2])
    if (![l, c, h].every(Number.isFinite)) return null
    return oklchToRgb(l, c, h)
  }
  return null
}

let probe: CanvasRenderingContext2D | null = null

/** Any CSS colour → sRGB through the browser (1×1 canvas), or null. */
function resolveViaCanvas(value: string): Rgb | null {
  if (typeof document === 'undefined') return null
  try {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!probe) return null
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = '#000'
    probe.fillStyle = value
    probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  } catch {
    return null
  }
}

export function cssColor(value: string, fallback: Rgb): Rgb {
  if (!value.trim()) return fallback
  return parseCssColor(value) ?? resolveViaCanvas(value) ?? fallback
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t)
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)]
}

export function rgba(c: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, alpha).toFixed(3)})`
}

/** Text colour readable on `bg`: near-black on light fills, white on dark ones (WCAG relative luminance). */
export function inkOn(bg: Rgb): string {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const l = 0.2126 * lin(bg[0]) + 0.7152 * lin(bg[1]) + 0.0722 * lin(bg[2])
  // the luminance where black and white text have the same contrast ratio
  return l > 0.179 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.95)'
}

/** C=0, G=1, D=2 … F=11 (the --chord-N index of a pitch class). */
export function fifthsIndex(pc: number): number {
  return (((pc % 12) + 12) % 12 * 7) % 12
}

/** Colour of a pitch class (0..11). */
export function pitchColor(p: Palette, pc: number): Rgb {
  return p.chord[fifthsIndex(pc)]
}

/** Chord colour with the app's minor treatment (78 % hue + 22 % muted, as chordTone()). */
export function chordRgb(p: Palette, rootPc: number | null, minor: boolean): Rgb {
  if (rootPc === null) return p.faint
  const base = pitchColor(p, rootPc)
  return minor ? mix(base, p.muted, 0.22) : base
}

const DARK_FALLBACK: Rgb[] = [
  [237, 124, 106], [239, 151, 88], [233, 186, 76], [176, 196, 82], [104, 197, 128], [86, 196, 186],
  [96, 178, 223], [117, 154, 243], [149, 135, 245], [190, 122, 228], [229, 115, 177], [236, 117, 130],
]

/** Reads the palette from <html> (call again when data-theme changes). */
export function readPalette(root: HTMLElement = document.documentElement): Palette {
  const cs = getComputedStyle(root)
  const dark = (root.dataset.theme ?? 'dark') !== 'light'
  const get = (name: string, fallback: Rgb) => cssColor(cs.getPropertyValue(name), fallback)
  return {
    dark,
    chord: Array.from({ length: 12 }, (_, i) => get(`--chord-${i}`, DARK_FALLBACK[i])),
    bg: get('--bg', dark ? [12, 12, 14] : [246, 245, 241]),
    surface: get('--surface', dark ? [20, 20, 23] : [255, 255, 255]),
    surface2: get('--surface-2', dark ? [27, 27, 31] : [240, 239, 234]),
    border: get('--border', dark ? [38, 38, 44] : [227, 225, 218]),
    text: get('--text', dark ? [243, 242, 239] : [23, 22, 26]),
    muted: get('--muted', dark ? [163, 162, 168] : [95, 93, 102]),
    faint: get('--faint', dark ? [108, 107, 115] : [149, 147, 155]),
    accent: get('--accent', dark ? [255, 181, 71] : [224, 138, 0]),
    // same key colours as the chord diagrams (.cw-piano in chords.css)
    keyWhite: dark ? [232, 230, 224] : [255, 255, 255],
    keyBlack: dark ? [16, 16, 19] : [38, 37, 43],
  }
}
