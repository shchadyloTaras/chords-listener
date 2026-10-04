// Canvas renderer of the live piano: a falling-notes roll (~3 s ahead) above a keyboard whose keys go
// down, light up in the note's colour and flash on every attack — drawn imperatively at display rate.
//
// Timing (per frame): the player's time is read straight from the controller and smoothed by
// LiveClock; the frame is drawn for the moment it reaches the screen (one refresh ahead) minus the
// user's sync offset. Media players report the position that is being heard (Chromium/Gecko/WebKit
// subtract the audio device latency), so no extra AudioContext latency is applied to the song —
// doing so would light the keys late; preview notes arrive already in audible performance time.
//
// Idle = no animation frames: the loop runs only while playing, while preview notes sound / glow, or
// once after a change (seek, resize, data, theme).
//
// Vocal overlay (optional): the sung melody (lib/vocals) drawn as outlined notes in the ink colour —
// distinct from the instruments' pitch colours — and a dot on the key the singer is on.
import { useApp } from '../../../store'
import type { LiveNote } from '../../../lib/liveNotes'
import type { NoteIndex } from '../../../lib/transcription'
import { fitRange, foldNote, layoutKeyboard, maxOctavesFor, type KeyboardLayout, type KeyRange, type KeyRect } from './keyboard'
import { FrameLead, LiveClock } from './liveClock'
import { chordRgb, mix, pitchColor, rgba, type Palette, type Rgb } from './palette'

/** seconds of music visible above the keys */
export const LOOKAHEAD = 3
const GLOW_MS = 260
const FLASH_MS = 150
const FELT = 4
const PRESS_DEPTH = 2
/** s: while paused, notes starting this soon after the playhead count as pressed */
const PAUSED_REACH = 0.08

export interface RollChord {
  start: number
  label: string
  rootPc: number | null
  minor: boolean
}

export interface FrameInfo {
  /** music time drawn (s) */
  time: number
  playing: boolean
  /** keys shown down (MIDI, after transposition / folding), ascending */
  keys: number[]
  /** keys the singer is on (vocal overlay), ascending */
  vocals: number[]
  range: KeyRange
}

export interface RendererOptions {
  /** the set of keys down changed (for the screen-reader summary) */
  onKeys?(keys: number[]): void
  /** the canvas size changed: total height and the roll's part of it (css px) */
  onLayout?(height: number, rollHeight: number): void
}

interface Pressed {
  color: Rgb
  velocity: number
  /** ms since the attack (Infinity: not a fresh attack — paused, or a seek landed inside the note) */
  age: number
  fold: -1 | 0 | 1
}

const BLACK_PC = new Set([1, 3, 6, 8, 10])

function prettyLabel(label: string): string {
  return label.replace(/(^|\/)([A-G])#/g, '$1$2♯').replace(/(^|\/)([A-G])b/g, '$1$2♭')
}

function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class PianoRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly opts: RendererOptions
  private palette: Palette
  private index: NoteIndex | null = null
  private vocals: NoteIndex | null = null
  private transpose = 0
  private chords: RollChord[] = []
  private downbeats: number[] = []
  private reduced = false
  private visible = true
  private cssW = 0
  private cssH = 0
  private rollH = 0
  private dpr = 1
  private layout: KeyboardLayout | null = null
  private range: KeyRange = { low: 36, high: 83 }
  private previews: LiveNote[] = []
  private readonly clock = new LiveClock()
  private readonly lead = new FrameLead()
  private continuousFrom = 0
  private raf = 0
  private destroyed = false
  private lastKeys = ''
  private glowing = false
  private readonly tmp: number[] = []
  private readonly tmp2: number[] = []
  private readonly pressed = new Map<number, Pressed>()
  private readonly unsubscribe: () => void
  private readonly sung = new Set<number>()
  private readonly tmp3: number[] = []
  readonly info: FrameInfo = { time: 0, playing: false, keys: [], vocals: [], range: this.range }

  constructor(canvas: HTMLCanvasElement, palette: Palette, opts: RendererOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D canvas is not available')
    this.ctx = ctx
    this.palette = palette
    this.opts = opts
    // test / debugging hooks: the frame that was drawn last, and drawing one right now (e.g. in a
    // background tab, where animation frames do not run)
    Object.defineProperty(canvas, '__livePiano', { value: this.info, configurable: true })
    Object.defineProperty(canvas, '__livePianoDraw', { value: () => this.drawNow(), configurable: true })
    this.unsubscribe = useApp.subscribe((s, p) => {
      if (
        s.currentTime !== p.currentTime ||
        s.isPlaying !== p.isPlaying ||
        s.controller !== p.controller ||
        s.playbackRate !== p.playbackRate ||
        s.syncOffsetMs !== p.syncOffsetMs
      )
        this.invalidate()
    })
  }

  // ------------------------------------------------------------------ inputs

  setNotes(index: NoteIndex | null): void {
    if (this.index === index) return
    this.index = index
    this.refit()
  }

  /** The sung melody to overlay (null = none). */
  setVocals(index: NoteIndex | null): void {
    if (this.vocals === index) return
    this.vocals = index
    this.refit()
  }

  setTranspose(n: number): void {
    if (this.transpose === n) return
    this.transpose = n
    this.refit()
  }

  setChords(chords: RollChord[], downbeats: number[]): void {
    this.chords = chords
    this.downbeats = downbeats
    this.invalidate()
  }

  setPalette(p: Palette): void {
    this.palette = p
    this.invalidate()
  }

  setReducedMotion(reduced: boolean): void {
    if (this.reduced === reduced) return
    this.reduced = reduced
    this.relayout()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) this.invalidate()
  }

  /** Width of the container (css px). */
  resize(width: number): void {
    const w = Math.max(0, Math.floor(width))
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    if (w === this.cssW && dpr === this.dpr) return
    const narrowChanged = maxOctavesFor(w) !== maxOctavesFor(this.cssW)
    this.cssW = w
    this.dpr = dpr
    if (narrowChanged || !this.layout) this.refit()
    else this.relayout()
  }

  /**
   * Preview notes (performance.now() times) from onLiveNotes. A note emitted again with the same pitch
   * and start is an update (the sound engine cuts notes short when a new chord replaces them; an end
   * at the start means it never sounded).
   */
  addPreview(notes: readonly LiveNote[]): void {
    const now = performance.now()
    this.previews = this.previews.filter((n) => n.end > now - GLOW_MS)
    for (const n of notes) {
      if (!Number.isFinite(n.start) || !Number.isFinite(n.end)) continue
      const same = this.previews.findIndex((p) => p.midi === n.midi && Math.abs(p.start - n.start) < 0.5)
      if (same >= 0) {
        if (n.end > n.start) this.previews[same] = { ...n }
        else this.previews.splice(same, 1)
      } else if (n.end > n.start) this.previews.push({ ...n })
    }
    this.invalidate()
  }

  destroy(): void {
    this.destroyed = true
    this.unsubscribe()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  invalidate(): void {
    if (this.destroyed || this.raf || !this.visible || !this.cssW) return
    this.raf = requestAnimationFrame(this.frame)
  }

  /** Draws a frame synchronously (debugging / tests). */
  drawNow(): FrameInfo {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.frame(performance.now())
    return this.info
  }

  // ------------------------------------------------------------------ layout

  private refit(): void {
    if (!this.cssW) return
    const weights = new Float64Array(128)
    for (const idx of [this.index, this.vocals]) {
      if (!idx) continue
      const raw = idx.pitchWeights()
      for (let m = 0; m < 128; m++) {
        const t = m + this.transpose
        if (t >= 0 && t < 128) weights[t] += raw[m]
      }
    }
    this.range = fitRange(weights, { minOctaves: 4, maxOctaves: maxOctavesFor(this.cssW) })
    this.relayout()
  }

  private relayout(): void {
    if (!this.cssW) return
    const narrow = this.cssW < 640
    this.layout = layoutKeyboard(this.range, this.cssW, { minHeight: narrow ? 64 : 72, maxHeight: narrow ? 104 : 136 })
    this.rollH = this.reduced ? 0 : narrow ? 112 : Math.round(Math.min(200, Math.max(128, window.innerHeight * 0.2)))
    this.cssH = this.rollH + FELT + Math.round(this.layout.whiteH) + 2
    this.opts.onLayout?.(this.cssH, this.rollH)
    this.canvas.style.height = `${this.cssH}px`
    this.canvas.width = Math.round(this.cssW * this.dpr)
    this.canvas.height = Math.round(this.cssH * this.dpr)
    this.info.range = this.range
    this.invalidate()
  }

  // ------------------------------------------------------------------ frame loop

  private frame = (ts: number): void => {
    this.raf = 0
    if (this.destroyed || !this.layout) return
    const now = performance.now()
    const lead = this.lead.tick(ts)
    const s = useApp.getState()
    const playing = s.isPlaying && !!s.controller
    let media = s.currentTime
    if (playing && s.controller) {
      try {
        const t = s.controller.getTime()
        if (Number.isFinite(t)) media = t
      } catch {
        /* the player is not ready yet */
      }
    }
    const rate = s.playbackRate > 0 ? s.playbackRate : 1
    const t = this.clock.update({ now, media, playing, rate })
    if (this.clock.jumped) this.continuousFrom = t
    // draw what will be heard when this frame is on screen (≈ one refresh from now), shifted by the
    // user's correction (positive = keys later)
    const offsetMs = Number.isFinite(s.syncOffsetMs) ? s.syncOffsetMs : 0
    const drawT = playing ? t + (rate * (lead - offsetMs)) / 1000 : t
    const previewNow = now + lead - offsetMs
    this.draw(drawT, playing, rate, previewNow)
    const previewsLeft = this.previews.some((n) => n.end > previewNow - GLOW_MS)
    // off screen (scrolled away) the loop pauses; setVisible(true) resumes it
    if ((playing || previewsLeft || this.glowing) && this.visible) this.raf = requestAnimationFrame(this.frame)
    else {
      this.lead.pause()
      if (!previewsLeft) this.previews = []
    }
  }

  // ------------------------------------------------------------------ drawing

  private collectPressed(t: number, playing: boolean, rate: number, previewNow: number): void {
    const pressed = this.pressed
    pressed.clear()
    const p = this.palette
    const put = (midi: number, velocity: number, age: number) => {
      if (midi < 0 || midi > 127) return
      const f = foldNote(midi, this.range)
      const prev = pressed.get(f.key)
      if (prev) {
        prev.velocity = Math.max(prev.velocity, velocity)
        prev.age = Math.min(prev.age, age)
        if (f.fold) prev.fold = f.fold
        return
      }
      pressed.set(f.key, { color: pitchColor(p, f.key % 12), velocity, age, fold: f.fold })
    }
    const idx = this.index
    if (idx) {
      const { start, midi, velocity } = idx.notes
      // paused: what is sounding here, including attacks a hair later (a chord's detected start may
      // sit a few ms before its notes)
      const list = playing ? idx.activeAt(t, this.tmp) : idx.inRange(t, t + PAUSED_REACH, this.tmp)
      for (const i of list) {
        const fresh = playing && start[i] >= this.continuousFrom - 1e-6
        put(midi[i] + this.transpose, playing ? velocity[i] : velocity[i] * 0.8, fresh ? ((t - start[i]) / rate) * 1000 : Infinity)
      }
    }
    for (const n of this.previews) if (n.start <= previewNow && previewNow < n.end) put(n.midi, Math.min(1, Math.max(0.15, n.velocity)), previewNow - n.start)
    this.sung.clear()
    const v = this.vocals
    if (v) {
      const list = playing ? v.activeAt(t, this.tmp3) : v.inRange(t, t + PAUSED_REACH, this.tmp3)
      for (const i of list) {
        const m = v.notes.midi[i] + this.transpose
        if (m >= 0 && m <= 127) this.sung.add(foldNote(m, this.range).key)
      }
    }
  }

  private draw(t: number, playing: boolean, rate: number, previewNow: number): void {
    const layout = this.layout
    if (!layout) return
    const { ctx, palette: p } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.collectPressed(t, playing, rate, previewNow)
    this.glowing = false
    const W = this.cssW
    const hitY = this.rollH

    // panel background (the canvas is opaque)
    ctx.fillStyle = rgba(p.surface)
    ctx.fillRect(0, 0, W, this.cssH)
    if (this.rollH > 0) this.drawRoll(t, layout)
    this.drawFelt(W, hitY)
    if (!this.reduced) this.drawGlows(layout, hitY)
    this.drawKeys(layout, hitY + FELT)
    if (this.sung.size) this.drawSung(layout, hitY + FELT)

    // frame info (screen-reader summary, tests)
    const keys = [...this.pressed.keys()].sort((a, b) => a - b)
    const sig = keys.join(',')
    this.info.time = t
    this.info.playing = playing
    this.info.keys = keys
    this.info.vocals = [...this.sung].sort((a, b) => a - b)
    if (sig !== this.lastKeys) {
      this.lastKeys = sig
      this.opts.onKeys?.(keys)
    }
  }

  private drawRoll(t: number, layout: KeyboardLayout): void {
    const { ctx, palette: p } = this
    const W = this.cssW
    const H = this.rollH
    const dark = p.dark
    const bg = dark ? mix(p.bg, p.surface, 0.35) : mix(p.surface2, p.bg, 0.4)
    ctx.fillStyle = rgba(bg)
    ctx.fillRect(0, 0, W, H)
    // black-key lanes and octave lines, like a piano-roll grid
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.20)' : 'rgba(0,0,0,0.035)'
    for (const k of layout.blacks) ctx.fillRect(k.x, 0, k.w, H)
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'
    for (const k of layout.whites) if (k.midi % 12 === 0 && k.x > 0) ctx.fillRect(Math.round(k.x), 0, 1, H)

    const yOf = (time: number) => H - ((time - t) / LOOKAHEAD) * H

    // bar lines (downbeats), very faint
    const db = this.downbeats
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.06)'
    for (let i = lowerBound(db, t); i < db.length && db[i] <= t + LOOKAHEAD; i++) ctx.fillRect(0, Math.round(yOf(db[i])), W, 1)

    // chord changes: lines under the notes, labels (displayed names) above them
    const chords = this.chords
    let first = 0
    {
      let lo = 0
      let hi = chords.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (chords[mid].start <= t) lo = mid + 1
        else hi = mid
      }
      first = lo
    }
    let last = first
    while (last < chords.length && chords[last].start <= t + LOOKAHEAD) last++
    const fadeAt = (y: number) => Math.min(1, (H - y) / 18, (y + 2) / 14)
    for (let ci = first; ci < last; ci++) {
      const c = chords[ci]
      const y = Math.round(yOf(c.start))
      const fade = fadeAt(y)
      if (fade <= 0) continue
      ctx.fillStyle = rgba(chordRgb(p, c.rootPc, c.minor), (dark ? 0.42 : 0.5) * fade)
      ctx.fillRect(0, y, W, 1)
    }

    // falling notes: white-key notes first, black-key notes on top
    const idx = this.index
    if (!idx) {
      this.drawChordLabels(first, last, yOf, fadeAt)
      return
    }
    const list = idx.inRange(t, t + LOOKAHEAD, this.tmp2)
    const { start, end, midi, velocity } = idx.notes
    for (const pass of [false, true]) {
      for (const i of list) {
        const m = midi[i] + this.transpose
        const f = foldNote(m, this.range)
        if (BLACK_PC.has(f.key % 12) !== pass) continue
        const yBottom = Math.min(H, yOf(start[i]))
        const yTop = Math.max(-2, yOf(end[i]))
        if (yBottom - yTop < 1) continue
        const [x, w] = layout.lane(f.key)
        const v = velocity[i]
        const base = pitchColor(p, f.key % 12)
        const sounding = start[i] <= t
        let fill = dark ? mix(bg, base, 0.5 + 0.5 * v) : mix(bg, base, 0.55 + 0.45 * v)
        if (pass) fill = mix(fill, [0, 0, 0], dark ? 0.16 : 0.1)
        if (sounding) fill = mix(fill, dark ? [255, 255, 255] : base, dark ? 0.16 : 0.25)
        const r = Math.min(4, w / 3, (yBottom - yTop) / 2)
        ctx.fillStyle = rgba(fill)
        this.roundRect(x, yTop, w, yBottom - yTop, r)
        ctx.fill()
        ctx.strokeStyle = rgba(mix(base, [0, 0, 0], dark ? 0.45 : 0.25), 0.9)
        ctx.lineWidth = 1
        ctx.stroke()
        // a lighter cap at the note's end
        if (yTop > -1 && yBottom - yTop > 5) {
          ctx.fillStyle = rgba(mix(fill, [255, 255, 255], 0.35), 0.9)
          ctx.fillRect(x + 1.5, yTop + 1, Math.max(0, w - 3), 1.5)
        }
        if (f.fold && yBottom - yTop > 8) this.foldMark(x + w / 2, yBottom - 6, f.fold, dark)
      }
    }
    this.drawVocalRoll(t, layout, yOf)
    this.drawChordLabels(first, last, yOf, fadeAt)
  }

  /** Sung notes: outlined bars in the ink colour, over the instruments' notes. */
  private drawVocalRoll(t: number, layout: KeyboardLayout, yOf: (time: number) => number): void {
    const v = this.vocals
    if (!v) return
    const { ctx, palette: p } = this
    const H = this.rollH
    const ink = p.text
    const list = v.inRange(t, t + LOOKAHEAD, this.tmp3)
    const { start, end, midi } = v.notes
    ctx.lineWidth = 1.5
    for (const i of list) {
      const f = foldNote(midi[i] + this.transpose, this.range)
      const yBottom = Math.min(H, yOf(start[i]))
      const yTop = Math.max(-2, yOf(end[i]))
      if (yBottom - yTop < 1) continue
      const [x, w] = layout.lane(f.key)
      const r = Math.min(5, w / 2.5, (yBottom - yTop) / 2)
      const sounding = start[i] <= t
      ctx.fillStyle = rgba(ink, sounding ? 0.3 : 0.14)
      this.roundRect(x - 1, yTop, w + 2, yBottom - yTop, r)
      ctx.fill()
      ctx.strokeStyle = rgba(ink, sounding ? 1 : 0.85)
      ctx.stroke()
    }
  }

  /** A dot in the ink colour on each key the singer is on. */
  private drawSung(layout: KeyboardLayout, y0: number): void {
    const { ctx, palette: p } = this
    for (const key of this.sung) {
      const k = layout.keys[key]
      if (!k) continue
      const black = BLACK_PC.has(key % 12)
      const cx = k.x + k.w / 2
      const cy = y0 + k.h - (black ? Math.max(7, k.h * 0.18) : Math.max(9, k.h * 0.14))
      const rad = Math.max(3, Math.min(5.5, k.w * (black ? 0.3 : 0.22)))
      ctx.beginPath()
      ctx.arc(cx, cy, rad + 1.5, 0, Math.PI * 2)
      ctx.fillStyle = black ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.55)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(cx, cy, rad, 0, Math.PI * 2)
      ctx.fillStyle = rgba(black ? p.keyBlack : p.dark ? [20, 20, 23] : p.text)
      ctx.fill()
    }
  }

  private drawChordLabels(first: number, last: number, yOf: (time: number) => number, fadeAt: (y: number) => number): void {
    const { ctx, palette: p } = this
    ctx.font = '600 11px "Space Grotesk Variable", "Inter Variable", ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'alphabetic'
    for (let ci = first; ci < last; ci++) {
      const c = this.chords[ci]
      const y = Math.round(yOf(c.start))
      const fade = fadeAt(y)
      if (fade <= 0) continue
      const col = chordRgb(p, c.rootPc, c.minor)
      const text = prettyLabel(c.label)
      const tw = ctx.measureText(text).width
      const bx = 8
      ctx.fillStyle = rgba(p.surface, 0.9 * fade)
      this.roundRect(bx - 4, y - 16, tw + 8, 15, 4)
      ctx.fill()
      ctx.strokeStyle = rgba(col, 0.5 * fade)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = rgba(p.dark ? col : mix(col, p.text, 0.25), fade)
      ctx.fillText(text, bx, y - 5)
    }
  }

  /** small triangle: ▼ the note is really lower than the keyboard, ▲ higher */
  private foldMark(cx: number, cy: number, dir: -1 | 1, dark: boolean): void {
    const { ctx } = this
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)'
    ctx.beginPath()
    if (dir < 0) {
      ctx.moveTo(cx - 3, cy - 2)
      ctx.lineTo(cx + 3, cy - 2)
      ctx.lineTo(cx, cy + 2)
    } else {
      ctx.moveTo(cx - 3, cy + 2)
      ctx.lineTo(cx + 3, cy + 2)
      ctx.lineTo(cx, cy - 2)
    }
    ctx.closePath()
    ctx.fill()
  }

  private drawFelt(W: number, y: number): void {
    const { ctx, palette: p } = this
    // the strip of felt behind the keys (a dark red, like on a real piano)
    const g = ctx.createLinearGradient(0, y, 0, y + FELT)
    if (p.dark) {
      g.addColorStop(0, 'rgb(74,24,27)')
      g.addColorStop(1, 'rgb(38,12,14)')
    } else {
      g.addColorStop(0, 'rgb(150,48,46)')
      g.addColorStop(1, 'rgb(104,30,30)')
    }
    ctx.fillStyle = g
    ctx.fillRect(0, y, W, FELT)
  }

  private drawGlows(layout: KeyboardLayout, hitY: number): void {
    const { ctx, palette: p } = this
    let any = false
    ctx.save()
    ctx.globalCompositeOperation = p.dark ? 'lighter' : 'source-over'
    for (const [key, k] of this.pressed) {
      const rect = layout.keys[key]
      if (!rect) continue
      const cx = rect.x + rect.w / 2
      const fresh = k.age < GLOW_MS ? 1 - k.age / GLOW_MS : 0
      if (fresh > 0) any = true
      // a soft standing light where the note meets the keys, plus a flash on the attack
      const strength = (p.dark ? 0.16 : 0.1) * (0.5 + 0.5 * k.velocity) + fresh * fresh * (p.dark ? 0.55 : 0.32) * (0.45 + 0.55 * k.velocity)
      if (strength <= 0.01) continue
      const radius = Math.max(14, layout.whiteW * (1.1 + 1.4 * fresh))
      const g = ctx.createRadialGradient(cx, hitY, 0, cx, hitY, radius)
      g.addColorStop(0, rgba(k.color, Math.min(1, strength)))
      g.addColorStop(1, rgba(k.color, 0))
      ctx.fillStyle = g
      ctx.fillRect(cx - radius, Math.max(0, hitY - radius), radius * 2, Math.min(radius, hitY))
    }
    ctx.restore()
    this.glowing = any
  }

  private drawKeys(layout: KeyboardLayout, y0: number): void {
    const { ctx, palette: p } = this
    const dark = p.dark
    const whiteH = layout.whiteH
    // white keys
    const wg = ctx.createLinearGradient(0, y0, 0, y0 + whiteH)
    wg.addColorStop(0, rgba(mix(p.keyWhite, [0, 0, 0], dark ? 0.16 : 0.06)))
    wg.addColorStop(0.18, rgba(p.keyWhite))
    wg.addColorStop(1, rgba(mix(p.keyWhite, [255, 255, 255], 0.3)))
    for (const k of layout.whites) this.drawWhite(k, y0, wg, this.pressed.get(k.midi))
    // black keys cast a soft shadow on the whites
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)'
    for (const k of layout.blacks) {
      this.roundRect(k.x + 1, y0, k.w + 1.5, k.h + 2.5, 3)
      ctx.fill()
    }
    const bg = ctx.createLinearGradient(0, y0, 0, y0 + layout.blackH)
    bg.addColorStop(0, rgba(mix(p.keyBlack, [255, 255, 255], 0.16)))
    bg.addColorStop(1, rgba(p.keyBlack))
    for (const k of layout.blacks) this.drawBlack(k, y0, bg, this.pressed.get(k.midi))
    // edge hints for notes folded in from outside the range
    let low: Rgb | null = null
    let high: Rgb | null = null
    for (const k of this.pressed.values()) {
      if (k.fold < 0) low = k.color
      if (k.fold > 0) high = k.color
    }
    if (low) this.edgeGlow(0, y0, whiteH, low, 1)
    if (high) this.edgeGlow(this.cssW, y0, whiteH, high, -1)
  }

  private edgeGlow(x: number, y: number, h: number, color: Rgb, dir: 1 | -1): void {
    const { ctx } = this
    const w = 7
    const g = ctx.createLinearGradient(x, 0, x + dir * w, 0)
    g.addColorStop(0, rgba(color, 0.9))
    g.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(Math.min(x, x + dir * w), y, w, h)
  }

  private drawWhite(k: KeyRect, y0: number, gradient: CanvasGradient, pressed: Pressed | undefined): void {
    const { ctx, palette: p } = this
    const dark = p.dark
    const x = k.x + 0.5
    const w = k.w - 1
    const r = Math.min(4, w * 0.16)
    const depth = pressed ? PRESS_DEPTH : 0
    const lip = pressed ? Math.max(2, k.h * 0.03) : Math.max(3, k.h * 0.065)
    const h = k.h - depth
    // key body
    if (pressed) {
      const flash = pressed.age < FLASH_MS ? 1 - pressed.age / FLASH_MS : 0
      const amount = 0.5 + 0.42 * pressed.velocity
      let fill = mix(p.keyWhite, pressed.color, amount)
      if (flash > 0) fill = mix(fill, [255, 255, 255], 0.38 * flash)
      ctx.fillStyle = rgba(fill)
    } else ctx.fillStyle = gradient
    this.roundRect(x, y0, w, h, [0, 0, r, r])
    ctx.fill()
    // front edge of the key (its thickness): thinner when the key is down
    ctx.fillStyle = pressed ? rgba(mix(pressed.color, [0, 0, 0], 0.35), 0.75) : dark ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.1)'
    this.roundRect(x, y0 + h - lip, w, lip, [0, 0, r, r])
    ctx.fill()
    if (pressed) {
      // shadow at the back: the key sank below its neighbours
      const sg = ctx.createLinearGradient(0, y0, 0, y0 + Math.min(14, h * 0.2))
      sg.addColorStop(0, 'rgba(0,0,0,0.32)')
      sg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sg
      ctx.fillRect(x, y0, w, Math.min(14, h * 0.2))
      if (pressed.fold) this.foldMark(x + w / 2, y0 + h - lip - 7, pressed.fold, false)
    }
    // the gap between keys
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.2)'
    ctx.fillRect(Math.round(k.x + k.w) - 0.5, y0, 1, k.h)
  }

  private drawBlack(k: KeyRect, y0: number, gradient: CanvasGradient, pressed: Pressed | undefined): void {
    const { ctx, palette: p } = this
    const depth = pressed ? PRESS_DEPTH : 0
    const h = k.h - depth
    const r = Math.min(2.5, k.w * 0.18)
    if (pressed) {
      const flash = pressed.age < FLASH_MS ? 1 - pressed.age / FLASH_MS : 0
      let fill = mix(p.keyBlack, pressed.color, 0.58 + 0.38 * pressed.velocity)
      if (flash > 0) fill = mix(fill, [255, 255, 255], 0.3 * flash)
      ctx.fillStyle = rgba(fill)
    } else ctx.fillStyle = gradient
    this.roundRect(k.x, y0, k.w, h, [0, 0, r, r])
    ctx.fill()
    // the sloped front of the key, lit from above
    const slope = pressed ? Math.max(2, h * 0.06) : Math.max(4, h * 0.12)
    ctx.fillStyle = pressed ? rgba(mix(pressed.color, [255, 255, 255], 0.25), 0.55) : 'rgba(255,255,255,0.13)'
    this.roundRect(k.x + 1, y0 + h - slope, k.w - 2, slope - 1, [0, 0, r, r])
    ctx.fill()
    // a thin highlight on the top face
    ctx.fillStyle = pressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)'
    ctx.fillRect(k.x + k.w * 0.18, y0, Math.max(1, k.w * 0.14), h - slope - 1)
    if (pressed?.fold) this.foldMark(k.x + k.w / 2, y0 + h - slope - 6, pressed.fold, true)
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number | number[]): void {
    const { ctx } = this
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r)
    else ctx.rect(x, y, w, h)
  }
}
