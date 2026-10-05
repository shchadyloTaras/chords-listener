// Play-along hero: the current chord huge, the next one with a beat countdown, the previous
// one small, and the current chord's diagram beside it.

import { forwardRef, memo, useMemo, useRef, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import clsx from 'clsx'
import { Volume2 } from 'lucide-react'
import { useT } from '../../i18n'
import { chordTone } from '../../lib/music/color'
import { nextRealChord, prevRealChord, type DisplayChord } from '../../lib/music/display'
import { clickChordSound } from '../../lib/sound'
import { useApp, type Instrument } from '../../store'
import { ChordName } from './ChordName'
import { useClockEffect } from './clock'
import { ChordDiagram } from './diagrams/ChordDiagram'
import { HandpanHint } from './handpan/HandpanHint'
import { useChordModel } from './model'
import { Segmented } from './ui/controls'
import { useChordPos } from './usePlayhead'
import { TempoReadout } from './tempo/TempoReadout'

const MAX_DOTS = 8

/** Hero font scale by label length so long names ("C#m7b5/G#") still fit. */
function heroScale(label: string): number {
  const n = label.replace(/[#b]/g, '').length
  if (n <= 2) return 1
  if (n <= 4) return 0.82
  if (n <= 6) return 0.66
  return 0.52
}

export const NowPlaying = memo(
  forwardRef<HTMLElement>(function NowPlaying(_props, ref) {
    const t = useT()
    const model = useChordModel()
    const { chords, spelling } = model
    const instrument = useApp((s) => s.instrument)
    const showDiagrams = useApp((s) => s.showDiagrams)
    const chordSound = useApp((s) => s.chordSound)
    const setSetting = useApp((s) => s.setSetting)
    const reduce = useReducedMotion()

    const pos = useChordPos(chords)
    const cur: DisplayChord | null = pos >= 0 ? chords[pos] : null
    const nextIdx = pos === -2 ? -1 : nextRealChord(chords, pos >= 0 ? pos : -1)
    const prevIdx = pos === -1 ? -1 : prevRealChord(chords, pos >= 0 ? pos : chords.length)
    const next = nextIdx >= 0 ? chords[nextIdx] : null
    const upcoming: DisplayChord[] = []
    for (let i = nextIdx; i >= 0 && upcoming.length < 2; ) {
      i = nextRealChord(chords, i)
      if (i >= 0) upcoming.push(chords[i])
    }
    const prev = prevIdx >= 0 ? chords[prevIdx] : null

    const shown = cur && !cur.isNone ? cur : null
    const color = shown ? chordTone(shown.rootPc, shown.quality) : 'var(--chord-none)'
    const caption = shown
      ? null
      : pos === -2
        ? t('chords.now.end')
        : pos === -1 || !prev
          ? next
            ? t('chords.now.startsWith')
            : null
          : t('chords.now.noChord')

    const from = cur ? cur.start : pos === -1 ? 0 : null
    const to = next ? next.start : null
    const key = shown ? `c${shown.index}` : `x${pos}`
    const heroSize = `calc(clamp(4.6rem, 15vw, 9.5rem) * ${shown ? heroScale(shown.label) : 1})`

    return (
      <section
        ref={ref}
        aria-live="off"
        className="cw-stage relative overflow-hidden rounded-[28px] border border-border"
        style={{ '--cw-glow': shown ? color : 'transparent' } as CSSProperties}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4 sm:px-7 sm:pt-5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <TempoReadout />
            {instrument !== 'handpan' && model.capo && (
              <span className="text-xs text-muted" title={t('chords.capo.title', { n: model.capo.capo })}>
                {t('chords.capo.hint', { n: model.capo.capo, shapes: '' }).trim()}{' '}
                <span className="font-display text-sm font-semibold text-text">{model.capo.shapes.slice(0, 6).join(' ')}</span>
              </span>
            )}
          </div>
          <Segmented<Instrument>
            size="sm"
            label={t('chords.instrument')}
            value={instrument}
            onChange={(v) => setSetting('instrument', v)}
            options={(['guitar', 'ukulele', 'piano', 'handpan'] as const).map((v) => ({
              value: v,
              label: t(`chords.instrument.${v}`),
              title: t('chords.instrument.title'),
            }))}
          />
          {instrument === 'handpan' && <HandpanHint className="order-last basis-full" />}
        </div>

        <div className="flex items-end justify-between gap-4 px-5 pt-2 pb-5 sm:gap-8 sm:px-7 sm:pb-7">
          <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-8 gap-y-3 sm:gap-x-12">
            {/* current (a click plays it) */}
            <div className="relative min-w-0">
              <button
                type="button"
                disabled={!shown || !chordSound}
                data-cw-sound="click"
                onClick={(e) => shown && clickChordSound(shown.label, { from: e.currentTarget, color, feedback: 'glow' })}
                aria-label={shown && chordSound ? t('sound.playChord', { chord: shown.label }) : undefined}
                title={shown && chordSound ? t('sound.playChord', { chord: shown.label }) : undefined}
                className="group/hero relative block h-[clamp(4.6rem,15vw,9.5rem)] min-w-[2ch] cursor-pointer rounded-xl text-left disabled:cursor-default"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={key}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: [0.2, 0.7, 0.2, 1] }}
                    className="absolute bottom-0 left-0 origin-bottom-left"
                  >
                    {/* leading-none: a 1.5× line box would overflow the fixed-height box onto the tempo row */}
                    <span className="block leading-none" style={{ fontSize: heroSize }}>
                      <ChordName
                        label={shown ? shown.label : 'N'}
                        className={clsx(shown ? shown.confidence < 0.5 && 'cw-lowconf' : 'font-light text-border-strong')}
                      />
                    </span>
                  </motion.div>
                </AnimatePresence>
                {/* sizing ghost keeps the column as wide as the current label */}
                <span aria-hidden className="invisible block leading-none" style={{ fontSize: heroSize }}>
                  <ChordName label={shown ? shown.label : 'N'} />
                </span>
                <span
                  aria-hidden
                  className="absolute -bottom-2.5 left-1 h-1 w-12 rounded-full transition-[background-color,opacity] duration-300"
                  style={{ background: color, opacity: shown ? 1 : 0 }}
                />
                {shown && chordSound && (
                  <Volume2
                    aria-hidden
                    size={18}
                    className="pointer-events-none absolute top-1 -right-7 text-faint opacity-0 transition-opacity duration-150 group-hover/hero:opacity-100 group-focus-visible/hero:opacity-100"
                  />
                )}
              </button>
              <div className="mt-5 flex h-5 items-center gap-2 text-sm text-muted">
                {caption ? (
                  <span>{caption}</span>
                ) : prev ? (
                  <>
                    <span className="text-faint">{t('chords.now.prev')}</span>
                    <ChordName label={prev.label} className="text-base text-muted" />
                  </>
                ) : null}
              </div>
            </div>

            {/* next + countdown */}
            <div className={clsx('min-w-0 pb-7', !next && 'invisible')}>
              <div className="mb-1 text-sm text-faint">{t('chords.now.next')}</div>
              <div className="flex items-baseline gap-4">
                <button
                  type="button"
                  disabled={!next || !chordSound}
                  data-cw-sound="click"
                  onClick={(e) => next && clickChordSound(next.label, { from: e.currentTarget, color: chordTone(next.rootPc, next.quality), feedback: 'glow' })}
                  aria-label={next && chordSound ? t('sound.playNext', { chord: next.label }) : undefined}
                  title={next && chordSound ? t('sound.playNext', { chord: next.label }) : undefined}
                  className="group/next block cursor-pointer rounded-lg text-left disabled:cursor-default"
                >
                  <ChordName
                    label={next ? next.label : 'N'}
                    className={clsx(
                      'block text-[clamp(2.1rem,5.2vw,3.4rem)] transition-colors duration-150',
                      next ? 'text-muted' : 'font-light text-border-strong',
                      next && chordSound && 'group-hover/next:text-text group-focus-visible/next:text-text',
                    )}
                  />
                </button>
                {upcoming.length > 0 && (
                  <span className="hidden items-baseline gap-3 text-faint md:flex" aria-hidden>
                    {upcoming.map((c) => (
                      <ChordName key={c.index} label={c.label} className="text-2xl" />
                    ))}
                  </span>
                )}
              </div>
              {from != null && to != null && to > from ? (
                <Countdown from={from} to={to} color={next ? chordTone(next.rootPc, next.quality) : 'var(--accent)'} />
              ) : (
                <div className="mt-3 h-2" />
              )}
            </div>
          </div>

          {showDiagrams && (
            <div className="hidden shrink-0 self-center sm:block">
              <ChordDiagram label={shown ? shown.label : 'N'} instrument={instrument} size="lg" switcher spelling={spelling} />
            </div>
          )}
          {showDiagrams && (
            <div className="shrink-0 self-end sm:hidden">
              <ChordDiagram label={shown ? shown.label : 'N'} instrument={instrument} size="sm" spelling={spelling} />
            </div>
          )}
        </div>
      </section>
    )
  }),
)

/** Beat dots + a thin bar counting down to the next chord change; driven by the clock, no re-render. */
function Countdown({ from, to, color }: { from: number; to: number; color: string }) {
  const { beats } = useChordModel().rhythm
  const fill = useRef<HTMLDivElement>(null)
  const dots = useRef<HTMLDivElement>(null)
  const beatTimes = useMemo(() => {
    const tol = 0.08
    const inside = beats.filter((b) => b >= from - tol && b < to - tol)
    if (!inside.length || Math.abs(inside[0] - from) > tol * 2) inside.unshift(from)
    return inside
  }, [beats, from, to])
  const showDots = beatTimes.length >= 1 && beatTimes.length <= MAX_DOTS

  useClockEffect(
    (time) => {
      const p = Math.min(1, Math.max(0, (time - from) / (to - from)))
      if (fill.current) fill.current.style.transform = `scaleX(${p})`
      const el = dots.current
      if (!el) return
      const kids = el.children
      for (let i = 0; i < kids.length; i++) {
        const start = beatTimes[i]
        const end = beatTimes[i + 1] ?? to
        const s = time >= end ? 'past' : time >= start ? 'now' : 'next'
        const node = kids[i] as HTMLElement
        if (node.dataset.s !== s) node.dataset.s = s
      }
    },
    [from, to, beatTimes],
  )

  return (
    <div className="mt-3 w-[clamp(7rem,14vw,10rem)]" style={{ '--cw-beat-on': color } as CSSProperties}>
      {showDots && (
        <div ref={dots} className="mb-2 flex gap-1.5" aria-hidden>
          {beatTimes.map((b) => (
            <span key={b} className="cw-beat size-2 rounded-full bg-border-strong" data-s="next" />
          ))}
        </div>
      )}
      <div className="h-[3px] overflow-hidden rounded-full bg-border">
        <div ref={fill} className="cw-fill h-full rounded-full" style={{ background: color, transform: 'scaleX(0)' }} />
      </div>
    </div>
  )
}
