// Floating helpers above the player bar: the bar-selection action bar and the
// "back to playback" pill shown when the user scrolled away while following
// (not during a guided tour, which suspends following itself while nothing plays).

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Crosshair, Copy, Check, Repeat, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import { useTourStore } from '../tour/tourStore'
import { toggleLoop } from './hotkeys'
import { useChordModel } from './model'
import { selectionRange, useChordUi } from './uiStore'
import { copyBars, useCopyFeedback } from './useCopy'

export function Overlays() {
  const t = useT()
  const model = useChordModel()
  const selection = useChordUi((s) => s.selection)
  const clear = useChordUi((s) => s.clearSelection)
  const paused = useChordUi((s) => s.followPaused)
  const follow = useApp((s) => s.follow)
  const touring = useTourStore((s) => s.active !== null)
  const reduce = useReducedMotion()
  const { done, run } = useCopyFeedback()
  const range = selectionRange(selection)
  const showPill = follow && paused && !touring

  const anim = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 12 } }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center gap-2 px-4"
      style={{ bottom: 'var(--chords-bottom-offset, 96px)' }}
    >
      <AnimatePresence>
        {showPill && (
          <motion.button
            key="pill"
            type="button"
            {...anim}
            transition={{ duration: 0.16 }}
            onClick={() => useChordUi.getState().setFollowPaused(false)}
            className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full border border-border-strong bg-surface-3 px-4 text-sm font-medium shadow-[0_10px_30px_-10px_rgb(0_0_0/0.6)] hover:bg-surface-2"
          >
            <Crosshair size={16} className="text-accent" />
            {t('chords.follow.resume')}
          </motion.button>
        )}
        {range && (
          <motion.div
            key="sel"
            {...anim}
            transition={{ duration: 0.16 }}
            role="toolbar"
            aria-label={range[0] === range[1] ? t('chords.select.one', { n: range[0] + 1 }) : t('chords.select.range', { from: range[0] + 1, to: range[1] + 1 })}
            className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-border-strong bg-surface-3 p-1.5 pl-4 shadow-[0_10px_30px_-10px_rgb(0_0_0/0.6)]"
          >
            <span className="mr-2 text-sm font-medium tabular-nums">
              {range[0] === range[1] ? t('chords.select.one', { n: range[0] + 1 }) : t('chords.select.range', { from: range[0] + 1, to: range[1] + 1 })}
            </span>
            <button
              type="button"
              onClick={() => run(() => copyBars(model, { fromBar: range[0], toBar: range[1] }))}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-fg hover:brightness-105"
            >
              {done ? <Check size={15} strokeWidth={2.6} /> : <Copy size={15} />}
              {t('chords.select.copy')}
            </button>
            <button
              type="button"
              onClick={() => toggleLoop(model)}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-text hover:bg-surface-2"
            >
              <Repeat size={15} />
              {t('chords.select.loop')}
            </button>
            <button
              type="button"
              onClick={clear}
              aria-label={t('chords.select.clear')}
              title={t('chords.select.clear')}
              className="grid size-9 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-text"
            >
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
