// Sync offset for the live piano: a ±300 ms slider (positive = keys light later), reset, and a short
// explanation. The value persists locally (settings.syncOffsetMs, not synced across devices).

import { useState } from 'react'
import clsx from 'clsx'
import { Minus, Plus, Timer } from 'lucide-react'
import { useT } from '../../../i18n'
import { useApp } from '../../../store'
import { Floating } from '../ui/Floating'
import { measureOutputLatency } from './latency'

const SYNC_LIMIT_MS = 300
const STEP = 5

function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-SYNC_LIMIT_MS, Math.min(SYNC_LIMIT_MS, Math.round(ms / STEP) * STEP))
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0'
}

export function SyncControl() {
  const t = useT()
  const offset = useApp((s) => s.syncOffsetMs)
  const setSetting = useApp((s) => s.setSetting)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [latency, setLatency] = useState<number | null>(null)
  const value = clampOffset(offset)
  const set = (ms: number) => setSetting('syncOffsetMs', clampOffset(ms))

  const toggle = () => {
    setOpen((v) => !v)
    // a click is a user gesture: Web Audio may start here without an autoplay warning
    if (!open && latency === null) void measureOutputLatency().then(setLatency)
  }

  return (
    <>
      <button
        ref={setBtn}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('keys.sync.title')}
        className={clsx(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors',
          open || value ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-3 hover:text-text',
        )}
      >
        <Timer size={15} aria-hidden />
        <span className={clsx(!value && 'sr-only sm:not-sr-only')}>
          {value ? t('keys.sync.ms', { n: signed(value) }) : t('keys.sync')}
        </span>
      </button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} placement="bottom-end" ariaLabel={t('keys.sync.title')} className="w-80 max-w-[calc(100vw-16px)] p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">{t('keys.sync.title')}</span>
            <button
              type="button"
              onClick={() => set(0)}
              disabled={!value}
              className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-3 hover:text-text disabled:opacity-40"
            >
              {t('keys.sync.reset')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-label={`−${STEP}`} onClick={() => set(value - STEP)} className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-text">
              <Minus size={14} />
            </button>
            <input
              type="range"
              min={-SYNC_LIMIT_MS}
              max={SYNC_LIMIT_MS}
              step={STEP}
              value={value}
              onChange={(e) => set(Number(e.target.value))}
              aria-label={t('keys.sync.slider')}
              aria-valuetext={t('keys.sync.ms', { n: signed(value) })}
              className="cw-sync-range h-6 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]"
            />
            <button type="button" aria-label={`+${STEP}`} onClick={() => set(value + STEP)} className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-text">
              <Plus size={14} />
            </button>
          </div>
          <div className="flex items-baseline justify-between text-xs text-faint">
            <span>{t('keys.sync.earlier')}</span>
            <span className="font-mono text-sm font-semibold text-text tabular-nums" aria-live="polite">
              {t('keys.sync.ms', { n: signed(value) })}
            </span>
            <span>{t('keys.sync.later')}</span>
          </div>
          <p className="text-xs leading-relaxed text-muted">{t('keys.sync.hint')}</p>
          {latency !== null && <p className="text-xs leading-relaxed text-faint">{t('keys.sync.latency', { n: latency })}</p>}
        </div>
      </Floating>
    </>
  )
}
