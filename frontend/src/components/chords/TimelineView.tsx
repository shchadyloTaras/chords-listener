// Timeline view: a horizontally scrolling lane of chord blocks (width ∝ duration, colored by
// root), bar/beat ruler and waveform underneath. Playhead centered while following; click to
// seek; zoom with buttons or Ctrl/⌘ + wheel (anchored at the cursor). The lane starts at the
// track's view window (a fragment of a video: lib/viewWindow), x = (time − start) × zoom.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import clsx from 'clsx'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '../../i18n'
import type { DisplayChord } from '../../lib/music/display'
import { chordTone } from '../../lib/music/color'
import { formatTime } from '../../lib/music/formats'
import { clickChordSound } from '../../lib/sound'
import { sliceWaveform } from '../../lib/viewWindow'
import { useApp } from '../../store'
import { popoverIntent } from './popoverIntent'
import { ChordName } from './ChordName'
import { getClockTime, useClockEffect } from './clock'
import { useChordModel } from './model'
import { useChordUi, ZOOM_MAX, ZOOM_MIN } from './uiStore'
import { IconButton } from './ui/controls'
import { useChordPos } from './usePlayhead'

const RULER_H = 22
const LANE_H = 60
const WAVE_H = 52
const GAP = 6
const HEIGHT = RULER_H + LANE_H + GAP + WAVE_H + 8
const ZOOM_STEP = 1.4

export const TimelineView = memo(function TimelineView() {
  const t = useT()
  const { chords, bars, track, view } = useChordModel()
  const zoom = useChordUi((s) => s.zoom)
  const setZoom = useChordUi((s) => s.setZoom)
  const loop = useApp((s) => s.loop)
  const scroller = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const playedClip = useRef<SVGRectElement>(null)
  /** while zooming: seconds from the lane's start under the cursor, and the cursor's x */
  const anchor = useRef<{ time: number; x: number } | null>(null)
  const origin = view.start
  const span = Math.max(view.end, chords.length ? chords[chords.length - 1].end : 0) - origin
  const width = Math.max(1, Math.ceil(span * zoom))
  const pos = useChordPos(chords)

  // Playhead + follow-centering, every frame without re-rendering.
  useClockEffect(
    (time) => {
      const x = Math.max(0, (time - origin) * zoom)
      if (playhead.current) playhead.current.style.transform = `translateX(${x}px)`
      if (playedClip.current) playedClip.current.setAttribute('width', String(Math.max(0, x)))
      const el = scroller.current
      const ui = useChordUi.getState()
      if (el && useApp.getState().follow && !ui.followPaused && !anchor.current) {
        const target = x - el.clientWidth / 2
        if (Math.abs(el.scrollLeft - target) > 0.5) el.scrollLeft = target
      }
    },
    [zoom, origin],
  )

  // Re-centre right away when following resumes (also while paused).
  const followPaused = useChordUi((s) => s.followPaused)
  const follow = useApp((s) => s.follow)
  useEffect(() => {
    const el = scroller.current
    if (!el || !follow || followPaused) return
    el.scrollLeft = (getClockTime() - origin) * useChordUi.getState().zoom - el.clientWidth / 2
  }, [follow, followPaused, origin])

  // Keep the time under the cursor fixed while zooming.
  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (!el || !a) return
    el.scrollLeft = a.time * zoom - a.x
    anchor.current = null
  }, [zoom])

  const zoomAt = useCallback(
    (factor: number, clientX?: number) => {
      const el = scroller.current
      if (!el) return
      const z = useChordUi.getState().zoom
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor))
      if (next === z) return
      const rect = el.getBoundingClientRect()
      const x = clientX == null ? el.clientWidth / 2 : clientX - rect.left
      anchor.current = { time: (el.scrollLeft + x) / z, x }
      setZoom(next)
    },
    [setZoom],
  )

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX)
        return
      }
      if (Math.abs(e.deltaX) > 0 || e.shiftKey) useChordUi.getState().setFollowPaused(true)
    }
    const onTouch = () => useChordUi.getState().setFollowPaused(true)
    const onDown = (e: PointerEvent) => {
      // pressing the scrollbar itself
      if (e.target === el) useChordUi.getState().setFollowPaused(true)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouch, { passive: true })
    el.addEventListener('pointerdown', onDown)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouch)
      el.removeEventListener('pointerdown', onDown)
    }
  }, [zoomAt])

  const seekAt = (clientX: number, target: Element) => {
    const left = target.getBoundingClientRect().left
    useApp.getState().seek(origin + Math.max(0, (clientX - left) / zoom))
  }

  const ruler = useMemo(() => {
    if (!bars.length) return { path: '', beatPath: '', labels: [] as { x: number; n: number }[] }
    const avgBar = span / bars.length
    const every = [1, 2, 4, 8, 16, 32, 64].find((k) => k * avgBar * zoom >= 38) ?? 64
    let path = ''
    let beatPath = ''
    const labels: { x: number; n: number }[] = []
    const beatPx = (avgBar / Math.max(1, bars[0].beats)) * zoom
    for (const b of bars) {
      const x = Math.round((b.start - origin) * zoom) + 0.5
      path += `M${x} ${RULER_H - 9}V${HEIGHT}`
      if (b.index % every === 0) labels.push({ x, n: b.index + 1 })
      if (beatPx >= 7) for (let k = 1; k < b.boundaries.length - 1; k++) beatPath += `M${Math.round((b.boundaries[k] - origin) * zoom) + 0.5} ${RULER_H - 4}V${RULER_H}`
    }
    return { path, beatPath, labels }
  }, [bars, zoom, span, origin])

  const peaks = useMemo(() => sliceWaveform(track.waveform ?? [], track.duration, view), [track.waveform, track.duration, view])
  const wave = useMemo(() => {
    const w = peaks
    if (!w.length) return ''
    const n = w.length
    let top = `M0 50`
    let bottom = ''
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.02, Math.min(1, w[i])) * 48
      top += `L${i} ${(50 - v).toFixed(1)}`
      bottom = `L${i} ${(50 + v).toFixed(1)}` + bottom
    }
    return `${top}L${n - 1} 50${bottom}Z`
  }, [peaks])
  const waveN = Math.max(1, peaks.length - 1)
  const loopFrom = loop ? Math.max(loop.start, origin) : 0

  return (
    <div role="region" aria-label={t('chords.timeline.label')} className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-1">
        <span className="mr-2 hidden text-xs text-faint sm:inline">{t('chords.timeline.hint')}</span>
        <IconButton label={t('chords.timeline.zoomOut')} onClick={() => zoomAt(1 / ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>
          <ZoomOut size={16} />
        </IconButton>
        <IconButton label={t('chords.timeline.zoomIn')} onClick={() => zoomAt(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>
          <ZoomIn size={16} />
        </IconButton>
      </div>
      <div
        ref={scroller}
        className={clsx(
          'relative overflow-x-auto overflow-y-hidden rounded-2xl border border-border bg-surface',
          '[scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]',
        )}
      >
        <div className="relative" style={{ width, height: HEIGHT }}>
          {/* ruler + bar lines */}
          <svg
            aria-hidden
            width={width}
            height={HEIGHT}
            className="absolute inset-0 text-border-strong"
            onClick={(e) => seekAt(e.clientX, e.currentTarget)}
          >
            <path d={ruler.path} stroke="currentColor" strokeWidth={1} opacity={0.55} />
            <path d={ruler.beatPath} stroke="currentColor" strokeWidth={1} opacity={0.7} />
            {ruler.labels.map((l) => (
              <text key={l.x} x={l.x + 4} y={12} fontSize={10} fill="var(--faint)" style={{ fontFamily: 'var(--font-mono)' }}>
                {l.n}
              </text>
            ))}
          </svg>

          {/* waveform: full + played part */}
          <svg
            aria-hidden
            width={width}
            height={WAVE_H}
            viewBox={`0 0 ${waveN} 100`}
            preserveAspectRatio="none"
            className="absolute left-0 cursor-pointer"
            style={{ top: RULER_H + LANE_H + GAP }}
            onClick={(e) => seekAt(e.clientX, e.currentTarget)}
          >
            <path d={wave} fill="var(--border-strong)" opacity={0.7} />
          </svg>
          <svg aria-hidden width={width} height={WAVE_H} className="pointer-events-none absolute left-0" style={{ top: RULER_H + LANE_H + GAP }}>
            <defs>
              <clipPath id="cw-played">
                <rect ref={playedClip} x={0} y={0} width={0} height={WAVE_H} />
              </clipPath>
            </defs>
            <g clipPath="url(#cw-played)">
              <svg width={width} height={WAVE_H} viewBox={`0 0 ${waveN} 100`} preserveAspectRatio="none">
                <path d={wave} fill="var(--accent)" opacity={0.55} />
              </svg>
            </g>
          </svg>

          {loop && loop.end > loopFrom && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 border-x-2 border-accent bg-accent-soft"
              style={{ left: (loopFrom - origin) * zoom, width: Math.max(2, (loop.end - loopFrom) * zoom) }}
            />
          )}

          {/* chord blocks */}
          <div className="absolute inset-x-0" style={{ top: RULER_H, height: LANE_H }}>
            {chords.map((c) =>
              c.end > origin + 1e-6 ? <Block key={c.index} chord={c} origin={origin} zoom={zoom} active={c.index === pos} /> : null,
            )}
          </div>

          <div
            ref={playhead}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 z-10 h-full w-0.5 -translate-x-px bg-playhead shadow-[0_0_0_1px_var(--bg)]"
            style={{ willChange: 'transform' }}
          />
        </div>
      </div>
    </div>
  )
})

const Block = memo(function Block({ chord, origin, zoom, active }: { chord: DisplayChord; origin: number; zoom: number; active: boolean }) {
  const t = useT()
  const hovered = useChordUi((s) => !chord.isNone && s.hoverLabel === chord.label)
  // a chord already sounding when the lane starts is cut at its start
  const from = Math.max(chord.start, origin)
  const left = (from - origin) * zoom
  const w = (chord.end - from) * zoom
  const color = chordTone(chord.rootPc, chord.quality)
  const info = (el: HTMLElement, mode: 'info' | 'edit' = 'info') => ({ chordIndex: chord.index, anchor: el, mode, time: chord.start })

  if (chord.isNone) {
    return (
      <div
        className="cw-hatch absolute inset-y-1 rounded-md"
        style={{ left: left + 1, width: Math.max(0, w - 2) }}
        aria-hidden
      />
    )
  }
  return (
    <button
      type="button"
      data-chord={chord.index}
      data-cw-sound="seek"
      onClick={(e) => {
        useApp.getState().seek(chord.start)
        // paused: also hear the chord; the second click of a double-click (edit) stays silent
        if (e.detail < 2) clickChordSound(chord.label, { from: e.currentTarget, color, unlessPlaying: true })
      }}
      onDoubleClick={(e) => popoverIntent.openNow(info(e.currentTarget, 'edit'))}
      onPointerEnter={(e) => e.pointerType === 'mouse' && popoverIntent.openSoon(info(e.currentTarget))}
      onPointerLeave={(e) => e.pointerType === 'mouse' && popoverIntent.closeSoon()}
      onKeyDown={(e) => {
        if (e.key === 'F2' || e.code === 'KeyE') {
          e.preventDefault()
          popoverIntent.openNow(info(e.currentTarget, 'edit'))
        }
      }}
      aria-label={t('chords.chordAt', { chord: chord.label, time: formatTime(chord.start) })}
      title={chord.confidence < 0.5 ? `${chord.label} — ${t('chords.lowConfidence')}` : chord.label}
      className={clsx(
        'absolute inset-y-1 flex items-center overflow-hidden rounded-md border-l-[3px] text-left transition-[background-color,color,box-shadow] duration-150',
        hovered && 'ring-2 ring-[var(--cw-c)]',
      )}
      style={
        {
          '--cw-c': color,
          left: left + 1,
          width: Math.max(2, w - 2),
          borderColor: color,
          background: active ? color : `color-mix(in oklch, ${color} 16%, var(--surface))`,
          color: active ? 'var(--bg)' : color,
        } as CSSProperties
      }
    >
      {w >= 24 && (
        <span className="min-w-0 truncate px-1.5">
          <ChordName label={chord.label} className={clsx(w >= 56 ? 'text-xl' : 'text-sm', chord.confidence < 0.5 && 'cw-lowconf')} />
        </span>
      )}
    </button>
  )
})
