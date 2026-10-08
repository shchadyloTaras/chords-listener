// Live chords: the chord being heard now, huge (play-along readable, like the NowPlaying hero),
// with a provisional style while the recognizer is still deciding; the previous chords as a
// ribbon (most recent on the right); level meter, elapsed time, key and tempo; the current
// chord's diagram for the selected instrument.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import clsx from 'clsx'
import { CircleAlert } from 'lucide-react'
import { useT } from '../../i18n'
import type { LiveChord, LiveSession } from '../../lib/live'
import { chordTone } from '../../lib/music/color'
import { displayLabel } from '../../lib/music/display'
import { resolveSpelling } from '../../lib/music/key'
import type { Spelling } from '../../lib/music/notes'
import { useApp } from '../../store'
import type { ChordQuality, KeyInfo } from '../../types'
import { ChordName } from '../chords/ChordName'
import { ChordDiagram } from '../chords/diagrams/ChordDiagram'
import { InstrumentPicker } from '../chords/InstrumentPicker'
import { formatTime } from '../ui/format'
import { LiveLevelMeter } from './LiveLevelMeter'
import { QUIET_LEVEL, useQuiet } from './quiet'
import { StatusPill } from './status'
import { useLiveSession } from './useLiveSession'
import '../chords/chords.css'
import './live.css'

/** chips kept in the ribbon */
const RIBBON_MAX = 48
/** a no-chord stretch at least this long shows as a gap in the ribbon (s) */
const GAP_MIN_SEC = 1.5
/** minimum time between screen-reader announcements (ms) */
const ANNOUNCE_EVERY_MS = 2500

interface Shown {
  key: string
  label: string
  rootPc: number | null
  quality: ChordQuality | null
  isNone: boolean
  provisional: boolean
  start: number
  end: number
  color: string
}

function toShown(c: LiveChord, spelling: Spelling, simplify: boolean): Shown {
  const { label, parsed } = displayLabel(c.label, { transpose: 0, simplify, spelling })
  const isNone = label === 'N'
  return {
    key: `${c.start}`,
    label,
    rootPc: parsed?.rootPc ?? null,
    quality: parsed?.quality ?? null,
    isNone,
    provisional: c.provisional,
    start: c.start,
    end: c.end,
    color: isNone ? 'var(--chord-none)' : chordTone(parsed?.rootPc ?? null, parsed?.quality ?? null),
  }
}

/** Hero font scale by label length so long names ("C#m7b5/G#") still fit (as NowPlaying). */
function heroScale(label: string): number {
  const n = label.replace(/[#b]/g, '').length
  if (n <= 2) return 1
  if (n <= 4) return 0.82
  if (n <= 6) return 0.66
  return 0.52
}

/** A label for screen readers: ♯ / ♭ are read as "sharp" / "flat". */
function spoken(label: string): string {
  return label.replace(/#/g, '♯').replace(/([A-G])b/g, '$1♭')
}

export interface LiveChordsViewProps {
  session: LiveSession | null
  /** shown in the header (e.g. the video title) */
  title?: string
  /** smaller hero and diagram (none on phones), no instrument switch: for a panel next to a video */
  compact?: boolean
  className?: string
}

export const LiveChordsView = memo(function LiveChordsView({ session, title, compact = false, className }: LiveChordsViewProps) {
  const t = useT()
  const view = useLiveSession(session)
  const instrument = useApp((s) => s.instrument)
  const showDiagrams = useApp((s) => s.showDiagrams)
  const accidentals = useApp((s) => s.accidentals)
  const simplify = useApp((s) => s.simplify)
  const reduce = useReducedMotion()

  const spelling = resolveSpelling(accidentals, view.key)
  // the current chord object is new on every update; only these fields matter for the display
  const curLabel = view.current?.label ?? null
  const curStart = view.current?.start ?? 0
  const curProvisional = !!view.current?.provisional
  const current = useMemo(
    () =>
      curLabel === null
        ? null
        : toShown({ label: curLabel, start: curStart, end: curStart, confidence: 1, provisional: curProvisional }, spelling, simplify),
    [curLabel, curStart, curProvisional, spelling, simplify],
  )
  const ribbon = useRibbon(view.history, current, spelling, simplify)
  const quiet = useQuiet(view)
  const announcement = useAnnouncement(current, t)

  const running = view.state === 'running'
  const shown = current && !current.isNone ? current : null
  const color = shown ? shown.color : 'var(--chord-none)'
  const started = view.time > 0 || view.history.length > 0 || !!view.current

  let caption: string | null = null
  let captionTone: 'muted' | 'warn' | 'danger' = 'muted'
  if (view.error) {
    caption = t('live.error.analysis')
    captionTone = 'danger'
  } else if (view.state === 'idle') caption = t('live.idle.hint')
  else if (view.ended && view.state !== 'stopped') {
    caption = t('live.ended.hint')
    captionTone = 'warn'
  } else if (view.state === 'paused') caption = t('live.paused.hint')
  else if (view.state === 'stopped') caption = null
  else if (!shown && quiet) {
    caption = t('live.quiet')
    captionTone = 'warn'
  } else if (!shown) {
    caption = !started || (!current && view.history.length === 0)
      ? t('live.listening.hint')
      : view.level < QUIET_LEVEL
        ? t('live.silence')
        : t('live.noChord')
  } else if (shown.provisional) caption = t('live.provisional')

  return (
    <section
      aria-label={t('live.region')}
      className={clsx('cw-stage relative overflow-hidden border border-border', compact ? 'rounded-[22px]' : 'rounded-[28px]', className)}
      style={{ '--cw-glow': shown && running ? color : 'transparent' } as CSSProperties}
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {/* header: status, time, title | key, tempo, level */}
      <div className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2', compact ? 'px-4 pt-3' : 'px-5 pt-4 sm:px-7 sm:pt-5')}>
        {/* an explicit minimum (status + time): the title truncates, and on a narrow line the
            right group wraps below instead of overlapping */}
        <div className="flex min-w-[9rem] flex-1 items-center gap-x-3">
          <StatusPill state={view.state} ended={!!view.ended} />
          <span className="shrink-0 font-mono text-sm text-muted tabular-nums" title={t('live.elapsed', { time: formatTime(view.time) })}>
            {formatTime(view.time)}
          </span>
          {title && <span className="min-w-0 truncate text-sm text-muted" title={title}>{title}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view.key && <KeyBadge info={view.key} spelling={spelling} compact={compact} />}
          {view.tempo != null && view.tempo > 0 && (
            <span
              data-tour="live.tempo"
              className="inline-flex h-7 items-center rounded-lg px-1.5 font-mono text-xs text-muted tabular-nums"
              title={t('live.tempo.title', { n: Math.round(view.tempo) })}
            >
              {t('live.tempo', { n: Math.round(view.tempo) })}
            </span>
          )}
          <LiveLevelMeter level={view.level} active={running} size={compact ? 'sm' : 'md'} />
        </div>
      </div>

      {/* hero + diagram */}
      <div className={clsx('flex items-end justify-between gap-4', compact ? 'px-4 pt-1 pb-3' : 'px-5 pt-2 pb-4 sm:gap-8 sm:px-7 sm:pb-5')}>
        <Hero
          shown={shown}
          idleKey={view.state}
          compact={compact}
          reduce={!!reduce}
          caption={caption}
          captionTone={captionTone}
          error={!!view.error}
        />

        {compact && showDiagrams && (
          <div className="hidden shrink-0 self-center sm:block">
            <ChordDiagram label={shown ? shown.label : 'N'} instrument={instrument} size="sm" spelling={spelling} />
          </div>
        )}
        {!compact && showDiagrams && (
          <div className="flex shrink-0 flex-col items-center gap-2 self-center">
            <div className="hidden sm:block">
              <ChordDiagram label={shown ? shown.label : 'N'} instrument={instrument} size="lg" spelling={spelling} />
            </div>
            <div className="sm:hidden">
              <ChordDiagram label={shown ? shown.label : 'N'} instrument={instrument} size="sm" spelling={spelling} />
            </div>
            <div className="hidden sm:block">
              {/* rows of three or four: eight buttons in one row would squeeze the chord name on narrow screens */}
              <InstrumentPicker className="max-w-64 flex-wrap justify-center" />
            </div>
          </div>
        )}
      </div>

      <Ribbon items={ribbon} compact={compact} reduce={!!reduce} />
    </section>
  )
})

/** The current chord, huge, with its colour bar and a caption; re-renders only when they change. */
const Hero = memo(function Hero({
  shown,
  idleKey,
  compact,
  reduce,
  caption,
  captionTone,
  error,
}: {
  shown: Shown | null
  idleKey: string
  compact: boolean
  reduce: boolean
  caption: string | null
  captionTone: 'muted' | 'warn' | 'danger'
  error: boolean
}) {
  const t = useT()
  const heroBox = compact ? 'clamp(3.2rem, 11vw, 5.5rem)' : 'clamp(4.6rem, 15vw, 9.5rem)'
  const heroSize = `calc(${heroBox} * ${shown ? heroScale(shown.label) : 1})`
  return (
    <div className="min-w-0 flex-1" data-tour="live.chord">
      <div className="relative min-w-[2ch]" style={{ height: heroBox }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            // keyed by the label: a provisional boundary that moves by a frame does not re-animate
            key={shown ? `c:${shown.label}` : `none:${idleKey}`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.2, 0.7, 0.2, 1] }}
            className="absolute bottom-0 left-0 origin-bottom-left"
          >
            <span
              className="lv-hero block leading-none"
              data-provisional={shown?.provisional ? 'true' : 'false'}
              style={{ fontSize: heroSize }}
              title={shown?.provisional ? t('live.provisional.title') : undefined}
            >
              <ChordName label={shown ? shown.label : 'N'} className={clsx(!shown && 'font-light text-border-strong')} />
            </span>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className={clsx('flex items-center gap-3', compact ? 'mt-2' : 'mt-3')}>
        {shown && (
          <span
            aria-hidden
            className="lv-bar w-12 shrink-0"
            data-provisional={shown.provisional ? 'true' : 'false'}
            style={{ '--lv-color': shown.color } as CSSProperties}
          />
        )}
        <span
          className={clsx(
            'min-h-5 min-w-0 text-sm',
            captionTone === 'danger' ? 'text-danger' : captionTone === 'warn' ? 'text-accent' : 'text-muted',
          )}
        >
          {error && <CircleAlert aria-hidden className="mr-1 inline size-4 align-[-3px]" />}
          {caption}
        </span>
      </div>
    </div>
  )
})

function KeyBadge({ info, spelling, compact }: { info: KeyInfo; spelling: Spelling; compact: boolean }) {
  const t = useT()
  const { label: name, parsed } = displayLabel(info.name, { transpose: 0, simplify: false, spelling })
  return (
    <span
      data-tour="live.key"
      className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-sm"
      title={t('live.key.title', { key: name })}
      aria-label={`${t('live.key')}: ${name}`}
    >
      {!compact && <span className="hidden text-xs text-faint sm:inline">{t('live.key')}</span>}
      <span className="font-display font-semibold" style={{ color: chordTone(parsed?.rootPc ?? null, parsed?.quality ?? null) }}>
        {name}
      </span>
    </span>
  )
}

interface RibbonItem {
  key: string
  label: string
  color: string
  provisional: boolean
  now: boolean
  gap: boolean
}

/** History (+ the current chord as "now"), display labels merged, long silences as gaps. */
function useRibbon(history: LiveChord[], current: Shown | null, spelling: Spelling, simplify: boolean): RibbonItem[] {
  return useMemo(() => {
    const src = history.slice(-(RIBBON_MAX + 16))
    const out: RibbonItem[] = []
    const push = (c: Shown, now: boolean) => {
      const prev = out[out.length - 1]
      if (c.isNone) {
        if (c.end - c.start < GAP_MIN_SEC && !now) return
        if (now || (prev && prev.gap)) return
        out.push({ key: c.key, label: 'N', color: 'transparent', provisional: false, now: false, gap: true })
        return
      }
      if (prev && !prev.gap && prev.label === c.label) {
        prev.provisional = prev.provisional || c.provisional
        prev.now = prev.now || now
        return
      }
      out.push({ key: c.key, label: c.label, color: c.color, provisional: c.provisional, now, gap: false })
    }
    for (const c of src) push(toShown(c, spelling, simplify), false)
    if (current) push(current, true)
    while (out.length && out[0].gap) out.shift()
    return out.slice(-RIBBON_MAX)
  }, [history, current, spelling, simplify])
}

function sameItems(a: RibbonItem[], b: RibbonItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.key !== y.key || x.label !== y.label || x.provisional !== y.provisional || x.now !== y.now || x.color !== y.color) return false
  }
  return true
}

type RibbonProps = { items: RibbonItem[]; compact: boolean; reduce: boolean }

/** Re-renders only when the visible chips change (not on every ~10 Hz update). */
const Ribbon = memo(
  function Ribbon(props: RibbonProps) {
    return <RibbonList {...props} />
  },
  (a, b) => a.compact === b.compact && a.reduce === b.reduce && sameItems(a.items, b.items),
)

function RibbonList({ items, compact, reduce }: RibbonProps) {
  const t = useT()
  const scroller = useRef<HTMLOListElement>(null)
  const [stuck, setStuck] = useState(true)
  const stuckRef = useRef(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !stuckRef.current) return
    el.scrollTo({ left: el.scrollWidth, behavior: reduce ? 'auto' : 'smooth' })
  }, [items, reduce])

  // stay pinned to the newest chip when the ribbon or its chips change size (rotation, compact)
  const hasItems = items.length > 0
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) el.scrollLeft = el.scrollWidth
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasItems])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 24
    stuckRef.current = atEnd
    setStuck(atEnd)
  }

  return (
    <div className={clsx('border-t border-border/70', compact ? 'px-4 py-2.5' : 'px-5 py-3 sm:px-7 sm:py-4')}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold tracking-wider text-faint uppercase">{t('live.history')}</h3>
        {!stuck && (
          <button
            type="button"
            className="rounded-md px-1.5 text-xs text-muted hover:text-text"
            onClick={() => {
              stuckRef.current = true
              setStuck(true)
              const el = scroller.current
              el?.scrollTo({ left: el.scrollWidth, behavior: reduce ? 'auto' : 'smooth' })
            }}
          >
            {t('live.history.latest')} →
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className={clsx('flex items-center text-sm text-faint', compact ? 'h-10' : 'h-12')}>{t('live.history.empty')}</p>
      ) : (
        <ol
          ref={scroller}
          onScroll={onScroll}
          aria-label={t('live.history')}
          className={clsx('lv-ribbon flex items-stretch gap-1.5 overflow-x-auto', compact ? 'h-10' : 'h-12')}
        >
          {items.map((c) =>
            c.gap ? (
              <li key={c.key} className="lv-chip-gap flex w-6 shrink-0 items-center justify-center text-faint" aria-hidden>
                ·
              </li>
            ) : (
              <li
                key={c.key}
                className={clsx(
                  'lv-chip flex shrink-0 items-center rounded-lg px-2.5',
                  compact ? 'min-w-10 text-base' : 'min-w-12 text-lg sm:text-xl',
                )}
                data-provisional={c.provisional ? 'true' : 'false'}
                data-now={c.now ? 'true' : 'false'}
                aria-current={c.now ? 'true' : undefined}
                style={{ '--lv-color': c.color } as CSSProperties}
              >
                <ChordName label={c.label} className="mx-auto" />
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  )
}

/** Polite screen-reader text for confirmed chord changes, at most every ANNOUNCE_EVERY_MS. */
function useAnnouncement(current: Shown | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const [text, setText] = useState('')
  const last = useRef({ label: '', at: -Infinity })
  const latest = useRef<string | null>(null)
  const timer = useRef(0)
  const confirmed = current && !current.provisional ? current.label : null

  useEffect(() => {
    latest.current = confirmed
  })

  useEffect(() => {
    // nothing to say before the first chord, nor twice the same
    if (confirmed === null || confirmed === last.current.label || (confirmed === 'N' && last.current.label === '')) return
    const say = () => {
      timer.current = 0
      const label = latest.current
      if (label === null || label === last.current.label) return
      last.current = { label, at: performance.now() }
      setText(label === 'N' ? t('live.aria.noChord') : t('live.aria.chord', { chord: spoken(label) }))
    }
    const wait = ANNOUNCE_EVERY_MS - (performance.now() - last.current.at)
    if (wait <= 0) say()
    else if (!timer.current) timer.current = window.setTimeout(say, wait)
  }, [confirmed, t])

  useEffect(() => () => window.clearTimeout(timer.current), [])
  return text
}
