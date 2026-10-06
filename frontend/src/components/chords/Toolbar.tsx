// Sticky control bar: key / tempo / meter, transpose, simplify, accidentals,
// view, follow, settings menu and the copy split-button. Shows a mini "now → next" when the
// hero has scrolled out of view.

import { memo, useState } from 'react'
import clsx from 'clsx'
import { AudioWaveform, Crosshair, FileMusic, Minus, Plus, RotateCcw, Rows3, SlidersHorizontal, Volume2, Wand2 } from 'lucide-react'
import { useT } from '../../i18n'
import { chordTone } from '../../lib/music/color'
import { formatTranspose } from '../../lib/music/key'
import { INSTRUMENTS, isKeyboard, liveKeysInstrument } from '../../lib/instruments'
import { nextRealChord } from '../../lib/music/display'
import { playTestSound } from '../../lib/sound'
import { useApp, type Accidentals, type ChordView, type Instrument } from '../../store'
import { ChordName } from './ChordName'
import { getClockTime } from './clock'
import { CopyButton } from './CopyButton'
import { resetChords } from './edit'
import { HandpanScaleControls } from './handpan/HandpanScaleControls'
import { useChordModel } from './model'
import { useChordUi } from './uiStore'
import { Divider, IconButton, Segmented, ToggleChip } from './ui/controls'
import { Floating } from './ui/Floating'
import { useChordPos } from './usePlayhead'
import { TempoBadge } from './tempo/TempoBadge'

export const Toolbar = memo(function Toolbar({ heroVisible }: { heroVisible: boolean }) {
  const t = useT()
  const model = useChordModel()
  const { track, keyName, originalKeyName } = model
  const transpose = useApp((s) => s.transpose)
  const simplify = useApp((s) => s.simplify)
  const accidentals = useApp((s) => s.accidentals)
  const setSetting = useApp((s) => s.setSetting)
  const setTranspose = useApp((s) => s.setTranspose)

  return (
    <div
      data-cw-toolbar
      className="sticky z-30 -mx-4 border-b border-border/70 bg-bg/88 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6"
      style={{ top: 'var(--chords-sticky-top, 0px)' }}
    >
      <div className="flex items-center gap-2">
        <div className="cw-no-scrollbar cw-fade-end relative -my-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 pr-6">
          {!heroVisible ? (
            <MiniNow />
          ) : (
            <div className="flex shrink-0 items-center gap-1 pr-1">
              {keyName && (
                <span
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-sm"
                  aria-label={`${t('chords.key')}: ${keyName}`}
                  title={
                    transpose
                      ? t('chords.keyTransposed', { from: originalKeyName ?? '', to: keyName })
                      : t('chords.keyOriginal', { key: keyName })
                  }
                >
                  {transpose !== 0 && originalKeyName && (
                    <span className="font-display font-semibold text-faint line-through decoration-1">{originalKeyName}</span>
                  )}
                  <span
                    className="font-display font-semibold"
                    style={{ color: chordTone(keyName.replace(/m$/, ''), keyName.endsWith('m') ? 'min' : 'maj') }}
                  >
                    {keyName}
                  </span>
                </span>
              )}
              <TempoBadge className="hidden sm:inline-flex" />
              {!!track.timeSignature && (
                <span className="hidden h-9 items-center rounded-lg px-1 font-mono text-xs text-muted lg:inline-flex" title={t('chords.timeSig')}>
                  {track.timeSignature}/4
                </span>
              )}
            </div>
          )}

          <Divider />

          {/* transpose */}
          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t('chords.transpose')}>
            <IconButton label={t('chords.transpose.down')} onClick={() => setTranspose(transpose - 1)}>
              <Minus size={16} />
            </IconButton>
            <span
              className={clsx(
                'min-w-9 text-center font-mono text-sm font-semibold tabular-nums',
                transpose ? 'text-accent' : 'text-muted',
              )}
              aria-live="polite"
              title={t('chords.transpose')}
            >
              {formatTranspose(transpose)}
            </span>
            <IconButton label={t('chords.transpose.up')} onClick={() => setTranspose(transpose + 1)}>
              <Plus size={16} />
            </IconButton>
            {transpose !== 0 && (
              <IconButton label={t('chords.transpose.reset')} size="sm" onClick={() => setTranspose(0)}>
                <RotateCcw size={14} />
              </IconButton>
            )}
          </div>

          <Divider />

          <ToggleChip
            pressed={simplify}
            onClick={() => setSetting('simplify', !simplify)}
            title={t('chords.simplify.title')}
            icon={<Wand2 size={15} />}
          >
            {t('chords.simplify')}
          </ToggleChip>

          <Segmented<Accidentals>
            label={t('chords.accidentals')}
            value={accidentals}
            onChange={(v) => setSetting('accidentals', v)}
            options={[
              { value: 'auto', label: t('chords.accidentals.auto'), title: t('chords.accidentals.autoTitle') },
              { value: 'sharp', label: t('chords.accidentals.sharp'), title: t('chords.accidentals.sharpTitle') },
              { value: 'flat', label: t('chords.accidentals.flat'), title: t('chords.accidentals.flatTitle') },
            ]}
          />

          <div className="flex shrink-0 items-center gap-1 sm:hidden">
            <Divider />
            <ViewControls />
          </div>

          {track.edited && (
            <button
              type="button"
              onClick={() => void resetChords()}
              title={t('chords.edit.reset')}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted hover:bg-surface-3 hover:text-text"
            >
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              {t('chords.edit.edited')}
              <RotateCcw size={13} />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="hidden items-center gap-1 sm:flex">
            <ViewControls />
          </div>
          <CopyButton compact />
        </div>
      </div>
    </div>
  )
})

/** View switch, follow toggle and the settings menu (pinned right on ≥sm, scrolled on phones). */
function ViewControls() {
  const t = useT()
  const view = useApp((s) => s.view)
  const follow = useApp((s) => s.follow)
  const setSetting = useApp((s) => s.setSetting)
  return (
    <>
      <Segmented<ChordView>
        label={t('chords.view')}
        value={view}
        onChange={(v) => setSetting('view', v)}
        options={[
          {
            value: 'sheet',
            label: (
              <>
                <Rows3 size={15} aria-hidden />
                <span className="sr-only lg:not-sr-only">{t('chords.view.sheet')}</span>
              </>
            ),
            title: t('chords.view.title'),
          },
          {
            value: 'timeline',
            label: (
              <>
                <AudioWaveform size={15} aria-hidden />
                <span className="sr-only lg:not-sr-only">{t('chords.view.timeline')}</span>
              </>
            ),
            title: t('chords.view.title'),
          },
          {
            value: 'score',
            label: (
              <>
                <FileMusic size={15} aria-hidden />
                <span className="sr-only lg:not-sr-only">{t('score.view')}</span>
              </>
            ),
            title: t('chords.view.title'),
          },
        ]}
      />
      <IconButton
        label={t('chords.follow.title')}
        active={follow}
        aria-pressed={follow}
        onClick={() => {
          setSetting('follow', !follow)
          useChordUi.getState().setFollowPaused(false)
        }}
      >
        <Crosshair size={17} />
      </IconButton>
      <SettingsMenu />
    </>
  )
}

function SettingsMenu() {
  const t = useT()
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const barsPerLine = useApp((s) => s.barsPerLine)
  const showDiagrams = useApp((s) => s.showDiagrams)
  const instrument = useApp((s) => s.instrument)
  const keepAwake = useApp((s) => s.keepAwake)
  const setSetting = useApp((s) => s.setSetting)
  const collapse = useChordUi((s) => s.collapseRepeats)
  const sheetFit = useChordUi((s) => s.sheetFit)
  const setCollapse = useChordUi((s) => s.setCollapseRepeats)

  return (
    <>
      <IconButton ref={setBtn} label={t('chords.settings')} active={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <SlidersHorizontal size={16} />
      </IconButton>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} placement="bottom-start" ariaLabel={t('chords.settings')} className="w-76 max-w-[calc(100vw-16px)] p-3">
        <div className="space-y-3.5">
          <Row label={t('chords.instrument')}>
            <Segmented<Instrument>
              size="sm"
              label={t('chords.instrument')}
              value={instrument}
              onChange={(v) => setSetting('instrument', v)}
              options={INSTRUMENTS.map((v) => ({ value: v, label: t(`chords.instrument.${v}`) }))}
              className="flex-wrap"
            />
          </Row>
          {instrument === 'handpan' && (
            <Row label={t('handpan.scale')}>
              <HandpanScaleControls detailed />
            </Row>
          )}
          <Row label={t('chords.barsPerLine')}>
            <Segmented<number>
              size="sm"
              label={t('chords.barsPerLine')}
              value={barsPerLine}
              onChange={(v) => setSetting('barsPerLine', v)}
              options={[2, 4, 8].map((v) => ({
                value: v,
                label: String(v),
                dim: v > sheetFit,
                title: v > sheetFit ? t('chords.barsPerLine.tooWide') : undefined,
              }))}
            />
            <p className="text-xs leading-snug text-muted">
              {barsPerLine > sheetFit ? t('chords.barsPerLine.limited', { n: sheetFit }) : t('chords.barsPerLine.hint')}
            </p>
          </Row>
          <Switch checked={showDiagrams} onChange={(v) => setSetting('showDiagrams', v)} label={t('chords.diagrams')} />
          <LiveKeysSwitch />
          <Switch checked={collapse} onChange={setCollapse} label={t('chords.collapse')} hint={t('chords.collapse.title')} />
          <Switch
            checked={keepAwake}
            onChange={(v) => setSetting('keepAwake', v)}
            label={t('core.settings.keepAwake')}
            hint={t('core.settings.keepAwakeHint')}
          />
          <SoundSettings />
        </div>
      </Floating>
    </>
  )
}

/** Live piano under the hero (keyboards only); turning it on picks the piano unless a keyboard is chosen. */
function LiveKeysSwitch() {
  const t = useT()
  const on = useApp((s) => s.liveKeys && isKeyboard(s.instrument))
  const setSetting = useApp((s) => s.setSetting)
  return (
    <Switch
      checked={on}
      onChange={(v) => {
        setSetting('liveKeys', v)
        if (v) setSetting('instrument', liveKeysInstrument(useApp.getState().instrument))
      }}
      label={t('keys.settings.toggle')}
      hint={t('keys.settings.hint')}
    />
  )
}

/** Chord sound: play on click (sheet, timeline, legend, hero) on / off, its volume and a test button. */
function SoundSettings() {
  const t = useT()
  const model = useChordModel()
  const on = useApp((s) => s.chordSound)
  const volume = useApp((s) => s.chordSoundVolume)
  const setSetting = useApp((s) => s.setSetting)
  const pct = Math.round(volume * 100)
  return (
    <div className="space-y-3 border-t border-border pt-3.5">
      <Switch checked={on} onChange={(v) => setSetting('chordSound', v)} label={t('sound.settings.click')} hint={t('sound.settings.clickHint')} />
      <Row label={t('sound.settings.volume')}>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label={t('sound.settings.volume')}
            aria-valuetext={`${pct}%`}
            onChange={(e) => setSetting('chordSoundVolume', Number(e.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-accent"
          />
          <span className="w-9 shrink-0 text-right font-mono text-xs text-muted tabular-nums">{pct}%</span>
          <IconButton
            label={t('sound.settings.test')}
            size="sm"
            data-cw-sound="always"
            onClick={(e) => playTestSound(model, getClockTime(), e.currentTarget)}
          >
            <Volume2 size={15} />
          </IconButton>
        </div>
      </Row>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </div>
  )
}

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3" title={hint}>
      <span className="text-sm">
        {label}
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-text shadow transition-transform duration-150',
            checked && 'translate-x-4 bg-accent-fg',
          )}
        />
      </button>
    </label>
  )
}

/** Compact current → next chord for the sticky bar (when the hero is off-screen). */
function MiniNow() {
  const t = useT()
  const { chords } = useChordModel()
  const pos = useChordPos(chords)
  const cur = pos >= 0 && !chords[pos].isNone ? chords[pos] : null
  const ni = pos === -2 ? -1 : nextRealChord(chords, pos >= 0 ? pos : -1)
  const next = ni >= 0 ? chords[ni] : null
  return (
    <div className="mr-1 flex h-9 shrink-0 items-center gap-2 rounded-lg bg-surface-2 pr-3 pl-2.5">
      <span className="size-2 rounded-full" style={{ background: cur ? chordTone(cur.rootPc, cur.quality) : 'var(--chord-none)' }} />
      <ChordName label={cur ? cur.label : 'N'} className="min-w-[2.5ch] text-xl" />
      <span className="text-xs text-faint">{t('chords.now.next')}</span>
      <ChordName label={next ? next.label : 'N'} className="text-base text-muted" />
    </div>
  )
}
