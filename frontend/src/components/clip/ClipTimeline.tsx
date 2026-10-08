// The fragment window on the video's timeline: drag it, tap the line to move it there (centred), ←/→ move it by
// 1 s (Shift: 5 s), Home / End. A slider for screen readers; `touch-none` keeps a drag from scrolling the page.
import clsx from 'clsx'
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { formatRange, formatTime } from '../ui/format'
import { clipWindow, maxStart, nudgeStart, startFromDrag, startFromTap } from './clipWindow'

interface Props {
  start: number
  /** the video's length, null while unknown */
  duration: number | null
  /** where the video is now (the playhead) */
  now: number
  onChange(start: number): void
  disabled?: boolean
  label: string
}

export function ClipTimeline({ start, duration, now, onChange, disabled, label }: Props) {
  const lineRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; origin: number; moved: boolean } | null>(null)
  const total = duration && duration > 0 ? duration : null
  const range = clipWindow(start, total)
  const pct = (t: number) => (total ? `${Math.min(100, Math.max(0, (t / total) * 100))}%` : '0%')

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !total) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, origin: range.start, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !total) return
    if (Math.abs(e.clientX - d.x) > 3) d.moved = true
    if (d.moved) onChange(startFromDrag(d.origin, e.clientX - d.x, lineRef.current?.clientWidth ?? 0, total))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    const line = lineRef.current
    if (!d || d.moved || !total || !line) return
    // a tap: outside the window it moves there; on the window it stays
    const rect = line.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const at = fraction * total
    if (at < range.start || at > range.end) onChange(startFromTap(fraction, total))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = e.shiftKey ? 5 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(nudgeStart(start, -step, total))
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(nudgeStart(start, step, total))
    else if (e.key === 'Home') onChange(0)
    else if (e.key === 'End' && total) onChange(maxStart(total))
    else return
    e.preventDefault()
  }

  return (
    <div className="mt-3">
      <div
        ref={lineRef}
        data-tour="clip.window"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total ? maxStart(total) : 0}
        aria-valuenow={range.start}
        aria-valuetext={formatRange(range.start, range.end, ' – ')}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={onKeyDown}
        className={clsx(
          'relative h-12 touch-none rounded-xl bg-surface-2 select-none',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          disabled ? 'opacity-60' : 'cursor-pointer',
        )}
      >
        {total && (
          <>
            <div
              className="absolute inset-y-1 rounded-lg border-2 border-accent bg-accent/20"
              style={{ left: pct(range.start), width: `max(0.75rem, ${((range.end - range.start) / total) * 100}%)` }}
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-text/70"
              style={{ left: pct(now) }}
              aria-hidden="true"
            />
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between text-xs text-faint tabular-nums" aria-hidden="true">
        <span>0:00</span>
        <span>{total ? formatTime(total) : '–:––'}</span>
      </div>
    </div>
  )
}
