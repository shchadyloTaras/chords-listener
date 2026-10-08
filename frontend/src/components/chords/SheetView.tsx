// Sheet view: the song as a chord chart — bars with proportional beat placement, the current
// bar/chord lit with a moving progress fill, follow-scroll, bar selection, per-line copy and
// optional ×N folding of repeated lines.

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'
import { useT } from '../../i18n'
import { barIndexAt, buildLines, groupRepeats, type Bar, type BarSlot, type LineGroup } from '../../lib/music/bars'
import { splitLabel } from '../../lib/music/chord'
import { partKeys, songParts } from '../../lib/music/sections'
import { chordTone } from '../../lib/music/color'
import { formatTime } from '../../lib/music/formats'
import { clickChordSound } from '../../lib/sound'
import { useApp } from '../../store'
import { popoverIntent } from './popoverIntent'
import { ChordName } from './ChordName'
import { useClockEffect, useClockValue } from './clock'
import { isTypingTarget } from './hotkeys'
import { useChordModel } from './model'
import { SectionHeader } from './SongParts'
import { selectionRange, useChordUi } from './uiStore'
import { copyBars, useCopyFeedback } from './useCopy'

const MIN_BAR_PX = 74
const RIGHT_GUTTER_PX = 36
const LONG_PRESS_MS = 450

/** Share of bars whose chord names must fit untruncated when choosing bars per line. */
const READABLE_SHARE = 0.85

function isPhoneWidth(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 640
}

/** Slot is rendered with the smaller "narrow" chord size (kept in sync with <Slot>). */
function isNarrow(slot: BarSlot, bar: Bar): boolean {
  return slot.span * 2 < bar.beats || bar.slots.length > 2
}

/**
 * Approximate width (px) a slot needs to show its chord name without truncation: the label in
 * the display face (root 1em, raised accidental and quality/bass at ~0.6em, see chords.css)
 * plus the slot's horizontal padding.
 */
function slotNeedPx(slot: BarSlot, narrow: boolean, phone: boolean): number {
  const font = narrow ? (phone ? 16 : 20) : phone ? 21 : 27
  const padding = phone ? 12 : 20
  if (slot.isNone) return font * 1.2 + padding
  const { root, suffix, bass } = splitLabel(slot.label)
  const small = suffix + (bass ? `/${bass}` : '')
  // em widths measured in the browser: root ≈ 0.64, accidental ≈ 0.36, small glyphs ≈ 0.31 ("m" ≈ 0.45)
  let em = 0.64 + (root.length > 1 ? 0.36 : 0)
  for (const ch of small) em += ch === 'm' ? 0.45 : 0.31
  return em * font + padding
}

/**
 * Bar width at which most bars show every chord name in full. Slots are placed on the beat grid,
 * so a one-beat "E♭m7" in a 4/4 bar needs four times its own width.
 */
function readableBarPx(bars: Bar[], phone: boolean): number {
  if (!bars.length) return MIN_BAR_PX
  const needs = bars
    .map((bar) => Math.max(0, ...bar.slots.map((s) => (slotNeedPx(s, isNarrow(s, bar), phone) * bar.beats) / Math.max(1, s.span))))
    .sort((a, b) => a - b)
  return Math.max(MIN_BAR_PX, needs[Math.min(needs.length - 1, Math.floor(needs.length * READABLE_SHARE))])
}

/** Chord names may shrink down to this scale so the chosen bars per line still fit. */
const MIN_NAME_SCALE = 0.7

/**
 * Sheet layout for the user's "bars per line" setting: that many bars, with chord names scaled
 * down (to MIN_NAME_SCALE) when the line is tight. Only when even the smaller names would not
 * fit does it fall back to the most bars that do (`fit`), which the settings menu explains.
 */
function sheetLayout(setting: number, width: number, barPx: number): { perLine: number; scale: number; fit: number } {
  if (!width) return { perLine: setting, scale: 1, fit: 8 }
  // The per-line gutter is hidden on phones (< 640px) unless a line repeats.
  const usable = width - (isPhoneWidth() ? 0 : RIGHT_GUTTER_PX)
  const most = Math.floor(usable / (barPx * MIN_NAME_SCALE))
  const fit = [8, 4, 2].find((n) => n <= most) ?? 1
  const perLine = Math.min(setting, fit)
  const scale = Math.min(1, Math.max(MIN_NAME_SCALE, usable / perLine / barPx))
  return { perLine, scale, fit }
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function groupAt(groups: LineGroup[], t: number): number {
  let lo = 0
  let hi = groups.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const g = groups[mid]
    if (t < g.line.start) hi = mid - 1
    else if (t >= g.lines[g.lines.length - 1].end) lo = mid + 1
    else return mid
  }
  return -1
}

function slotAt(bar: Bar, t: number): number {
  for (let i = 0; i < bar.slots.length; i++) if (t < bar.slots[i].end) return i
  return bar.slots.length - 1
}

/** Keeps the current line comfortably in view (between the sticky toolbar and ~65% height). */
function keepInView(el: Element | null | undefined) {
  if (!el) return
  const r = el.getBoundingClientRect()
  const bar = document.querySelector('[data-cw-toolbar]')?.getBoundingClientRect()
  const top = (bar?.bottom ?? 0) + 12
  const bottom = window.innerHeight * 0.68
  if (r.top >= top && r.bottom <= bottom) return
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
}

export const SheetView = memo(function SheetView() {
  const t = useT()
  const { bars, sections, track } = useChordModel()
  const setting = useApp((s) => s.barsPerLine)
  const follow = useApp((s) => s.follow)
  const collapse = useChordUi((s) => s.collapseRepeats)
  const paused = useChordUi((s) => s.followPaused)
  const wrap = useRef<HTMLDivElement>(null)
  const width = useElementWidth(wrap)
  const phone = isPhoneWidth()
  const barPx = useMemo(() => readableBarPx(bars, phone), [bars, phone])
  const { perLine, scale, fit } = sheetLayout(setting, width, barPx)

  useEffect(() => {
    useChordUi.getState().setSheetFit(fit)
  }, [fit])

  // every song part starts a line, under its name
  const keys = useMemo(() => partKeys(sections), [sections])
  const renamed = useApp((s) => s.sectionKinds?.[track.id])
  const starts = useMemo(() => new Map(songParts(sections).length >= 2 ? sections.map((s) => [s.startBar, s]) : []), [sections])
  const breaks = useMemo(() => new Set(starts.keys()), [starts])
  const lines = useMemo(() => buildLines(bars, perLine, breaks), [bars, perLine, breaks])
  const groups = useMemo<LineGroup[]>(
    () => (collapse ? groupRepeats(lines, breaks) : lines.map((line) => ({ line, lines: [line] }))),
    [lines, collapse, breaks],
  )
  const current = useClockValue(useCallback((time: number) => groupAt(groups, time), [groups]))

  useEffect(() => {
    if (!follow || paused || current < 0) return
    keepInView(wrap.current?.querySelector(`[data-group="${current}"]`))
  }, [current, follow, paused, perLine])

  // Manual scrolling pauses following until "back to playback".
  useEffect(() => {
    if (!follow) return
    const pause = () => useChordUi.getState().setFollowPaused(true)
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) pause()
    }
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key) && !isTypingTarget(e.target)) pause()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchmove', pause, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchmove', pause)
      window.removeEventListener('keydown', onKey)
    }
  }, [follow])

  return (
    <div
      ref={wrap}
      role="region"
      aria-label={t('chords.sheet.label')}
      className="flex flex-col gap-2.5"
      style={{ '--cw-name-scale': scale } as CSSProperties}
    >
      {groups.map((g, gi) => {
        const section = starts.get(g.line.bars[0].index)
        return (
          <Fragment key={`${g.line.index}:${perLine}`}>
            {section && (
              <SectionHeader trackId={track.id} partKey={keys.get(section.group)!} renamed={!!renamed?.[keys.get(section.group)!]} section={section} />
            )}
            <SheetLine group={g} gi={gi} perLine={perLine} />
          </Fragment>
        )
      })}
    </div>
  )
})

/** Encodes (pass, bar position, slot position) of the playhead inside a line group, or -1. */
function activeIn(group: LineGroup, t: number): number {
  for (let k = 0; k < group.lines.length; k++) {
    const line = group.lines[k]
    if (t < line.start || t >= line.end) continue
    const p = barIndexAt(line.bars, t)
    if (p < 0) return -1
    return k * 10000 + p * 100 + slotAt(line.bars[p], t)
  }
  return -1
}

const SheetLine = memo(function SheetLine({ group, gi, perLine }: { group: LineGroup; gi: number; perLine: number }) {
  const t = useT()
  const active = useClockValue(useCallback((time: number) => activeIn(group, time), [group]))
  const selection = useChordUi((s) => s.selection)
  const loop = useApp((s) => s.loop)
  const range = selectionRange(selection)
  const pass = active >= 0 ? Math.floor(active / 10000) : -1
  const barPos = active >= 0 ? Math.floor(active / 100) % 100 : -1
  const slotPos = active >= 0 ? active % 100 : -1
  const rep = group.line
  const n = group.lines.length
  const live = pass >= 0 ? group.lines[pass] : null
  const first = rep.bars[0].index
  const last = rep.bars[rep.bars.length - 1].index

  return (
    <div data-group={gi} data-tour={gi === 0 ? 'song.grid' : undefined} className="group/line relative flex items-stretch">
      <div
        className="grid min-w-0 flex-1"
        style={{ gridTemplateColumns: `repeat(${perLine}, minmax(0, 1fr))` }}
      >
        {rep.bars.map((bar, p) => (
          <BarCell
            key={bar.index}
            bar={bar}
            live={live && p === barPos ? live.bars[p] : null}
            seekBar={(live ?? rep).bars[p]}
            activeSlot={p === barPos ? slotPos : -1}
            selected={!!range && bar.index >= range[0] && bar.index <= range[1]}
            inLoop={!!loop && bar.start < loop.end - 0.01 && bar.end > loop.start + 0.01}
            closing={p === rep.bars.length - 1}
            pickup={rep.pickup}
          />
        ))}
      </div>
      <div className={clsx('w-9 shrink-0 flex-col items-center justify-center gap-1', n > 1 ? 'flex' : 'hidden sm:flex')}>
        {n > 1 && (
          <span
            className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-semibold text-accent tabular-nums"
            title={pass >= 0 ? t('chords.repeat.pass', { i: pass + 1, n }) : t('chords.repeat.title', { n })}
          >
            {pass >= 0 ? `${pass + 1}/${n}` : `×${n}`}
          </span>
        )}
        <LineCopy from={first} to={last} />
      </div>
    </div>
  )
})

function LineCopy({ from, to }: { from: number; to: number }) {
  const t = useT()
  const model = useChordModel()
  const { done, run } = useCopyFeedback()
  return (
    <button
      type="button"
      aria-label={t('chords.line.copy')}
      title={t('chords.line.copy')}
      onClick={() => run(() => copyBars(model, { fromBar: from, toBar: to }))}
      className={clsx(
        'grid size-8 place-items-center rounded-lg text-muted transition-[opacity,color,background-color] hover:bg-surface-3 hover:text-text focus-visible:opacity-100',
        done ? 'text-success opacity-100' : 'opacity-0 group-hover/line:opacity-100 pointer-coarse:opacity-60',
      )}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  )
}

const BarCell = memo(function BarCell({
  bar,
  live,
  seekBar,
  activeSlot,
  selected,
  inLoop,
  closing,
  pickup,
}: {
  bar: Bar
  /** the bar actually playing (same position, maybe a later pass), when this cell is current */
  live: Bar | null
  seekBar: Bar
  activeSlot: number
  selected: boolean
  inLoop: boolean
  closing: boolean
  pickup: boolean
}) {
  const t = useT()
  const selectBar = useChordUi((s) => s.selectBar)
  return (
    <div
      data-bar={bar.index}
      className={clsx(
        'relative grid h-[68px] min-w-0 border-l-2 border-border-strong sm:h-[76px]',
        closing && 'border-r-2',
        live && 'bg-surface-2',
        selected && 'bg-accent-soft',
      )}
      style={{ gridTemplateColumns: `repeat(${bar.beats}, minmax(0, 1fr))` }}
    >
      {live && <BarProgress bar={live} />}
      {inLoop && <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-accent" />}
      {selected && <span aria-hidden className="pointer-events-none absolute inset-0 ring-1 ring-accent/50 ring-inset" />}
      <button
        type="button"
        data-tour={bar.index === 0 ? 'song.barNumber' : undefined}
        onClick={(e) => selectBar(bar.index, e.shiftKey)}
        title={t('chords.bar.select', { n: bar.index + 1 })}
        aria-label={t('chords.bar.select', { n: bar.index + 1 })}
        aria-pressed={selected}
        className={clsx(
          'absolute top-1 left-1 z-10 rounded px-1 font-mono text-[10px] leading-4 tabular-nums transition-colors hover:bg-surface-3 hover:text-text',
          selected ? 'text-accent' : 'text-faint',
        )}
      >
        {bar.index + 1}
      </button>
      {pickup && <span className="absolute right-1.5 bottom-1 text-[10px] text-faint">{t('chords.pickup')}</span>}
      {bar.slots.map((slot, i) => (
        <Slot
          key={`${i}:${slot.label}`}
          slot={slot}
          seekTime={seekBar.slots[i]?.start ?? slot.start}
          active={i === activeSlot}
          narrow={isNarrow(slot, bar)}
        />
      ))}
      <BeatDots beats={bar.beats} live={live} />
    </div>
  )
})

/** Moving fill across the current bar (transform only, driven by the clock). */
function BarProgress({ bar }: { bar: Bar }) {
  const fill = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLDivElement>(null)
  useClockEffect(
    (time) => {
      const p = Math.min(1, Math.max(0, (time - bar.start) / (bar.end - bar.start)))
      const tr = `scaleX(${p})`
      if (fill.current) fill.current.style.transform = tr
      if (line.current) line.current.style.transform = tr
    },
    [bar],
  )
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={fill} className="cw-fill absolute inset-0 bg-[color-mix(in_oklch,var(--accent)_9%,transparent)]" style={{ transform: 'scaleX(0)' }} />
      <div className="absolute inset-x-0 bottom-0 h-[2px]">
        <div ref={line} className="cw-fill h-full bg-accent" style={{ transform: 'scaleX(0)' }} />
      </div>
    </div>
  )
}

function BeatDots({ beats, live }: { beats: number; live: Bar | null }) {
  const ref = useRef<HTMLDivElement>(null)
  useClockEffect(
    (time) => {
      const el = ref.current
      if (!el) return
      const kids = el.children
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i] as HTMLElement
        let s = 'next'
        if (live) {
          const a = live.boundaries[i]
          const b = live.boundaries[i + 1]
          s = time >= b ? 'past' : time >= a ? 'now' : 'next'
        }
        if (node.dataset.s !== s) node.dataset.s = s
      }
    },
    [live],
  )
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-2 grid" style={{ gridTemplateColumns: `repeat(${beats}, minmax(0, 1fr))` }}>
      {Array.from({ length: beats }, (_, i) => (
        <span key={i} className="cw-beat ml-3 size-[5px] rounded-full bg-border-strong" data-s="next" />
      ))}
    </div>
  )
}

const Slot = memo(function Slot({
  slot,
  seekTime,
  active,
  narrow,
}: {
  slot: BarSlot
  seekTime: number
  active: boolean
  narrow: boolean
}) {
  const t = useT()
  const hovered = useChordUi((s) => !slot.isNone && s.hoverLabel === slot.label)
  const color = chordTone(slot.rootPc, slot.quality)
  const press = useRef(0)

  const info = (el: HTMLElement, mode: 'info' | 'edit' = 'info') => ({ chordIndex: slot.chordIndex, anchor: el, mode, time: seekTime })

  return (
    <div className="relative flex min-w-0 items-center pr-0.5 pl-1.5 sm:pl-3" style={{ gridColumn: `${slot.beat + 1} / span ${slot.span}` }}>
      <button
        type="button"
        data-chord={slot.chordIndex}
        data-cw-sound={slot.isNone ? undefined : 'seek'}
        onClick={(e) => {
          useApp.getState().seek(seekTime)
          // paused: also hear the chord (playing: the recording is heard there right away);
          // the second click of a double-click (edit) stays silent
          if (!slot.isNone && e.detail < 2) clickChordSound(slot.label, { from: e.currentTarget, color, unlessPlaying: true })
        }}
        onDoubleClick={(e) => popoverIntent.openNow(info(e.currentTarget, 'edit'))}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') popoverIntent.openSoon(info(e.currentTarget))
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') popoverIntent.closeSoon()
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return
          const el = e.currentTarget
          press.current = window.setTimeout(() => popoverIntent.openNow(info(el)), LONG_PRESS_MS)
        }}
        onPointerUp={() => window.clearTimeout(press.current)}
        onPointerCancel={() => window.clearTimeout(press.current)}
        onContextMenu={(e) => {
          if (press.current) e.preventDefault()
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) popoverIntent.openNow(info(e.currentTarget))
        }}
        onBlur={() => popoverIntent.closeSoon()}
        onKeyDown={(e) => {
          if (e.key === 'F2' || e.code === 'KeyE') {
            e.preventDefault()
            popoverIntent.openNow(info(e.currentTarget, 'edit'))
          }
        }}
        aria-label={t('chords.chordAt', { chord: slot.isNone ? t('chords.noChord') : slot.label, time: formatTime(seekTime) })}
        title={slot.lowConfidence ? t('chords.lowConfidence') : undefined}
        className={clsx(
          '-ml-1 max-w-full truncate rounded-lg px-1 py-1 text-left transition-[background-color,color,box-shadow] duration-150 select-none sm:-ml-1.5 sm:px-1.5',
          !active && 'hover:bg-surface-3',
          hovered && !active && 'ring-2 ring-[var(--cw-c)]',
        )}
        style={
          {
            '--cw-c': color,
            color: active ? 'var(--bg)' : slot.isNone ? 'var(--faint)' : color,
            background: active ? (slot.isNone ? 'var(--chord-none)' : color) : undefined,
          } as CSSProperties
        }
      >
        <ChordName
          label={slot.label}
          className={clsx(
            narrow ? 'cw-name-narrow' : 'cw-name-wide',
            slot.continued && !active && 'opacity-45',
            slot.lowConfidence && 'cw-lowconf',
          )}
        />
      </button>
    </div>
  )
})
