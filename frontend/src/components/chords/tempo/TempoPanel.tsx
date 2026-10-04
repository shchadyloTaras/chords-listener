// Tempo popover: overall + local BPM, tempo curve, ×½ / ×1 / ×2 correction, tap tempo and the
// metronome. Opened from the hero BPM readout and the toolbar BPM badge.

import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { Hand, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useT } from '../../../i18n'
import { TEMPO_FACTORS, tapRelation, type TempoFactor } from '../../../lib/tempo'
import { useApp } from '../../../store'
import { Kbd } from '../../ui/Kbd'
import { useChordModel } from '../model'
import { Floating } from '../ui/Floating'
import { differsNotably, factorLabel, useLocalBpm } from './hooks'
import { METRONOME_MAX_VOLUME, toggleMetronome } from './metronome'
import { MetronomeIcon } from './MetronomeIcon'
import { useTap } from './tapStore'
import { TempoSparkline } from './TempoSparkline'
import { setTempoFactor } from './useRhythm'

export function TempoPopover({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose(): void }) {
  const t = useT()
  return (
    <Floating
      anchor={anchor}
      open={open}
      onClose={onClose}
      placement="bottom-start"
      ariaLabel={t('tempo.title')}
      className="max-h-[calc(100dvh-16px)] w-[min(21rem,calc(100vw-16px))] overflow-y-auto p-4"
    >
      <TempoPanel />
    </Floating>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border pt-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function TempoPanel() {
  const t = useT()
  const { rhythm, track } = useChordModel()
  const rate = useApp((s) => s.playbackRate)
  const local = useLocalBpm(rhythm.beats)
  const global = rhythm.tempo
  const bpm = global != null ? Math.round(global) : null

  return (
    <div className="space-y-3.5">
      {/* overall + now */}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">{t('tempo.average')}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-display text-[2.5rem] leading-none font-semibold tabular-nums">{bpm ?? '—'}</span>
            <span className="text-xs font-semibold tracking-wider text-faint">{t('tempo.unit')}</span>
            {rhythm.factor !== 1 && (
              <span className="ml-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent" title={t('tempo.factor.chip', { f: factorLabel(rhythm.factor) })}>
                ×{factorLabel(rhythm.factor)}
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[11px] text-faint">{t('tempo.timeSig', { ts: rhythm.timeSignature })}</div>
        </div>
        <div className="shrink-0 text-right" title={t('tempo.nowTitle')}>
          <div className="text-xs text-muted">{t('tempo.local')}</div>
          <div className={clsx('mt-0.5 font-display text-2xl leading-none font-semibold tabular-nums', differsNotably(local, global) ? 'text-text' : 'text-muted')}>
            {local ?? '—'}
          </div>
        </div>
      </div>
      {bpm != null && Math.abs(rate - 1) > 0.001 && (
        <p className="-mt-1.5 text-xs text-faint">{t('tempo.atRate', { rate: formatRate(rate), n: Math.round(bpm * rate) })}</p>
      )}

      <TempoSparkline beats={rhythm.beats} duration={track.duration} global={global} />

      <FactorPicker />
      <TapSection />
      <MetronomeSection />
    </div>
  )
}

function formatRate(r: number): string {
  return String(Math.round(r * 100) / 100)
}

function FactorPicker() {
  const t = useT()
  const { rhythm, track } = useChordModel()
  const toast = useApp((s) => s.toast)
  const detected = rhythm.detectedTempo
  const labels: Record<TempoFactor, string> = {
    0.5: t('tempo.fix.half'),
    1: t('tempo.fix.detected'),
    2: t('tempo.fix.double'),
  }
  const apply = (f: TempoFactor) => {
    if (f === rhythm.factor) return
    setTempoFactor(track.id, f)
    if (detected) toast(t(f === 1 ? 'tempo.fix.reset' : 'tempo.fix.applied', { n: Math.round(detected * f) }), 'info')
  }
  return (
    <Section title={t('tempo.fix')}>
      <div role="radiogroup" aria-label={t('tempo.fix')} className="grid grid-cols-3 gap-1.5">
        {TEMPO_FACTORS.map((f) => {
          const on = f === rhythm.factor
          return (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => apply(f)}
              className={clsx(
                'flex min-w-0 flex-col items-center gap-1 rounded-lg border px-1 py-2 transition-colors duration-150',
                on ? 'border-accent/50 bg-accent-soft text-accent' : 'border-border text-muted hover:bg-surface-3 hover:text-text',
              )}
            >
              <span className={clsx('font-display text-lg leading-none font-semibold tabular-nums', !on && 'text-text')}>
                {detected ? Math.round(detected * f) : `×${factorLabel(f)}`}
              </span>
              <span className="max-w-full truncate text-[11px] leading-tight">{labels[f]}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-faint">{t('tempo.fix.hint')}</p>
    </Section>
  )
}

function TapSection() {
  const t = useT()
  const { rhythm, track } = useChordModel()
  const rate = useApp((s) => s.playbackRate)
  const tap = useTap((s) => s.tap)
  const bpm = useTap((s) => s.bpm)
  const count = useTap((s) => s.count)
  const seq = useTap((s) => s.seq)
  const toast = useApp((s) => s.toast)

  // What the listener actually hears right now: the corrected tempo at the current speed.
  const heard = rhythm.tempo != null ? rhythm.tempo * rate : null
  const relation = bpm != null && heard != null ? tapRelation(bpm, heard) : null
  const suggest =
    relation === 'double' ? rhythm.factor * 2 : relation === 'half' ? rhythm.factor / 2 : null
  const suggested = suggest != null && (TEMPO_FACTORS as readonly number[]).includes(suggest) ? (suggest as TempoFactor) : null

  // Retrigger the flash animation on every tap (T key included), keeping focus on the button.
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = btn.current
    if (!seq || !el) return
    el.classList.remove('tp-tap-flash')
    void el.offsetWidth
    el.classList.add('tp-tap-flash')
  }, [seq])

  return (
    <Section title={t('tempo.tap.yours')}>
      <div className="flex items-stretch gap-3">
        <button
          ref={btn}
          type="button"
          title={t('tempo.tap.title')}
          onPointerDown={(e) => {
            if (e.button === 0) tap()
          }}
          onClick={(e) => {
            // Pointer taps are counted on press (tighter timing); keyboard activation lands here.
            if (e.detail === 0) tap()
          }}
          className={clsx(
            'inline-flex h-14 w-24 shrink-0 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl border border-border-strong bg-surface-3 text-sm font-medium select-none',
            'transition-colors duration-150 hover:border-accent/50 active:bg-accent-soft',
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <Hand size={15} aria-hidden />
            {t('tempo.tap')}
          </span>
          <Kbd className="h-5 min-w-5 text-[11px]">T</Kbd>
        </button>
        <div className="flex min-w-0 flex-1 flex-col justify-center" aria-live="polite">
          {bpm != null ? (
            <>
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-2xl leading-none font-semibold tabular-nums">{Math.round(bpm)}</span>
                <span className="text-[11px] font-semibold tracking-wider text-faint">{t('tempo.unit')}</span>
                {heard != null && (
                  <span className="truncate text-xs text-faint">· {t('tempo.tap.vs', { n: Math.round(heard) })}</span>
                )}
              </div>
              {relation && (
                <div className={clsx('mt-1 text-xs', relation === 'match' ? 'text-success' : 'text-muted')}>
                  {t(`tempo.tap.${relation}`)}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-muted">{count === 1 ? t('tempo.tap.more') : t('tempo.tap.prompt')}</p>
          )}
        </div>
      </div>
      {suggested != null && rhythm.detectedTempo != null && (
        <button
          type="button"
          onClick={() => {
            setTempoFactor(track.id, suggested)
            toast(t('tempo.fix.applied', { n: Math.round((rhythm.detectedTempo ?? 0) * suggested) }), 'info')
          }}
          className="mt-2.5 inline-flex h-8 w-full items-center justify-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg transition hover:brightness-110"
        >
          {t('tempo.tap.apply', { f: factorLabel(suggested / rhythm.factor) })} · {Math.round(rhythm.detectedTempo * suggested)} {t('tempo.unit')}
        </button>
      )}
    </Section>
  )
}

function MetronomeSection() {
  const t = useT()
  const on = useApp((s) => s.metronome)
  const volume = useApp((s) => s.metronomeVolume)
  const muted = useApp((s) => s.muted)
  const isPlaying = useApp((s) => s.isPlaying)
  const setSetting = useApp((s) => s.setSetting)
  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const status = on ? (muted ? t('tempo.metronome.muted') : !isPlaying ? t('tempo.metronome.paused') : null) : null

  return (
    <Section title={t('tempo.metronome')} aside={<Kbd>K</Kbd>}>
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <MetronomeIcon className={clsx('size-[18px] shrink-0', on ? 'text-accent' : 'text-muted')} />
          <span className="text-sm">
            {t('tempo.metronome.hint')}
            {status && <span className="mt-0.5 block text-xs text-muted">{status}</span>}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('tempo.metronome.title')}
          onClick={() => toggleMetronome(!on)}
          className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-surface-3')}
        >
          <span
            className={clsx(
              'absolute top-0.5 left-0.5 size-4 rounded-full shadow transition-transform duration-150',
              on ? 'translate-x-4 bg-accent-fg' : 'bg-text',
            )}
          />
        </button>
      </label>
      <div className="mt-3 flex items-center gap-2.5">
        <VolIcon size={16} className="shrink-0 text-muted" aria-hidden />
        <input
          type="range"
          min={0}
          max={METRONOME_MAX_VOLUME}
          step={0.05}
          value={volume}
          aria-label={t('tempo.metronome.volume')}
          aria-valuetext={`${Math.round(volume * 100)}%`}
          onChange={(e) => setSetting('metronomeVolume', Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-accent"
        />
        <span className={clsx('w-11 shrink-0 text-right font-mono text-xs tabular-nums', volume > 1 ? 'text-accent' : 'text-muted')}>
          {Math.round(volume * 100)}%
        </span>
      </div>
    </Section>
  )
}
