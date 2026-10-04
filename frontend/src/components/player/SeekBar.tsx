import clsx from 'clsx'
import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import type { ChordSegment, Track } from '../../types'
import { chordColorVar } from '../ui/chordColor'
import { formatTime } from '../ui/format'

const BAR_SLOT_PX = 4

function buildWavePath(peaks: number[], bars: number): string {
  if (bars <= 0) return ''
  let max = 0
  for (const p of peaks) if (p > max) max = p
  const scale = max > 0 ? 1 / max : 0
  const per = peaks.length / bars
  let d = ''
  for (let i = 0; i < bars; i++) {
    let m = 0
    if (peaks.length) {
      const from = Math.floor(i * per)
      const to = Math.max(from + 1, Math.floor((i + 1) * per))
      for (let j = from; j < to && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j]
    }
    const h = Math.max(8, Math.min(100, m * scale * 100))
    const y = (100 - h) / 2
    d += `M${(i + 0.15).toFixed(2)} ${y.toFixed(1)}h0.7v${h.toFixed(1)}h-0.7z`
  }
  return d
}

const Wave = memo(function Wave({ d, bars, className }: { d: string; bars: number; className: string }) {
  return (
    <svg
      viewBox={`0 0 ${Math.max(1, bars)} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={clsx('absolute inset-x-0 top-0 h-8 w-full', className)}
    >
      <path d={d} fill="currentColor" />
    </svg>
  )
})

function isMinorish(q: ChordSegment['quality']): boolean {
  return typeof q === 'string' && (q.startsWith('min') || q === 'dim' || q === 'dim7' || q === 'hdim7')
}

/** Thin chord-colored ribbon under the waveform: where the harmony changes. */
const ChordStrip = memo(function ChordStrip({
  chords,
  duration,
  transpose,
}: {
  chords: ChordSegment[]
  duration: number
  transpose: number
}) {
  if (!duration) return null
  return (
    <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1.5">
      {chords.map((c) =>
        c.label === 'N' || !c.root ? null : (
          <span
            key={c.start}
            className="absolute inset-y-0 rounded-[2px] bg-clip-content pr-px"
            style={{
              left: `${(c.start / duration) * 100}%`,
              width: `${((c.end - c.start) / duration) * 100}%`,
              backgroundColor: chordColorVar(c.root, transpose),
              opacity: isMinorish(c.quality) ? 0.6 : 0.95,
            }}
          />
        ),
      )}
    </div>
  )
})

/**
 * Waveform seek bar: played/unplayed coloring, loop region, chord ribbon,
 * hover time tooltip, click / drag to seek. Arrow keys are handled globally (±5 s).
 */
export function SeekBar({ track }: { track: Track }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const duration = useApp((s) => s.duration || track.duration)
  const currentTime = useApp((s) => s.currentTime)
  const loop = useApp((s) => s.loop)
  const transpose = useApp((s) => s.transpose)
  const [hover, setHover] = useState<number | null>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const dragging = useRef(false)
  const pendingSeek = useRef<number | null>(null)
  const seekFrame = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const bars = Math.max(24, Math.floor(width / BAR_SLOT_PX))
  const d = useMemo(() => buildWavePath(track.waveform ?? [], bars), [track.waveform, bars])

  const fracAt = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  const seekSoon = (time: number) => {
    pendingSeek.current = time
    if (seekFrame.current) return
    seekFrame.current = requestAnimationFrame(() => {
      seekFrame.current = 0
      if (pendingSeek.current !== null) useApp.getState().seek(pendingSeek.current)
      pendingSeek.current = null
    })
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !duration) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    const f = fracAt(e.clientX)
    setScrub(f)
    useApp.getState().seek(f * duration)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = fracAt(e.clientX)
    if (e.pointerType === 'mouse') setHover(f)
    if (dragging.current) {
      setScrub(f)
      seekSoon(f * duration)
    }
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!dragging.current) return
    dragging.current = false
    if (commit) useApp.getState().seek(fracAt(e.clientX) * duration)
    setScrub(null)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      useApp.getState().seek(e.key === 'Home' ? 0 : Math.max(0, duration - 0.5))
    }
  }

  const shown = scrub !== null ? scrub * duration : currentTime
  const playedPct = duration ? Math.min(100, (shown / duration) * 100) : 0
  const tipFrac = scrub ?? hover

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={t('core.player.seek')}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={t('core.player.timeOf', { time: formatTime(shown, duration), total: formatTime(duration) })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      className="group relative h-11 min-w-0 flex-1 cursor-pointer touch-none rounded-md select-none focus-visible:outline-offset-4"
    >
      <div className="absolute inset-x-0 top-1.5 bottom-0">
        {loop && duration > 0 && (
          <div
            aria-hidden="true"
            className="absolute top-0 h-8 rounded-sm border-x-2 border-accent bg-accent-soft"
            style={{
              left: `${(loop.start / duration) * 100}%`,
              width: `${(Math.max(0, loop.end - loop.start) / duration) * 100}%`,
            }}
          />
        )}
        <Wave d={d} bars={bars} className="text-border-strong" />
        <div
          aria-hidden="true"
          className="absolute inset-0 text-accent"
          style={{ clipPath: `inset(0 ${100 - playedPct}% 0 0)` }}
        >
          <Wave d={d} bars={bars} className="" />
        </div>
        <ChordStrip chords={track.chords} duration={duration} transpose={transpose} />
        <div
          aria-hidden="true"
          className="absolute top-[-3px] h-[38px] w-0.5 -translate-x-1/2 rounded-full bg-playhead"
          style={{ left: `${playedPct}%` }}
        />
      </div>
      {tipFrac !== null && duration > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 rounded-md border border-border-strong bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-text tabular-nums shadow-lg"
          style={{ left: `clamp(24px, ${tipFrac * 100}%, calc(100% - 24px))` }}
        >
          {formatTime(tipFrac * duration, duration)}
        </div>
      )}
    </div>
  )
}
