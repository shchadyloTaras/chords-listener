import clsx from 'clsx'
import { motion } from 'framer-motion'
import { Gauge, Pause, Play, Repeat, RotateCcw, RotateCw, Video, Volume1, Volume2, VolumeX, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import { SEEK_STEP, SPEEDS, seekBy } from '../../hooks/useHotkeys'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuLabel } from '../ui/Menu'
import { formatSpeed, formatTime } from '../ui/format'
import { usePlayerUi } from './playerUi'

export function PlayButton() {
  const t = useT()
  const isPlaying = useApp((s) => s.isPlaying)
  const ready = useApp((s) => Boolean(s.controller))
  const label = isPlaying ? t('core.player.pause') : t('core.player.play')
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => useApp.getState().toggle()}
      aria-label={label}
      title={`${label} (${t('core.keys.space')})`}
      className={clsx(
        'inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg',
        'shadow-lg shadow-accent/20 transition duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50',
      )}
    >
      {isPlaying ? <Pause className="size-5" fill="currentColor" /> : <Play className="ml-0.5 size-5" fill="currentColor" />}
    </button>
  )
}

export function SkipButton({ dir }: { dir: 1 | -1 }) {
  const t = useT()
  const Icon = dir < 0 ? RotateCcw : RotateCw
  return (
    <IconButton
      label={dir < 0 ? t('core.player.back', { n: SEEK_STEP }) : t('core.player.forward', { n: SEEK_STEP })}
      hint={dir < 0 ? '←' : '→'}
      onClick={() => seekBy(dir * SEEK_STEP)}
      size="lg"
    >
      <span className="relative inline-flex">
        <Icon className="size-[22px]" strokeWidth={1.75} />
        <span className="absolute inset-0 flex items-center justify-center pt-px text-[8px] font-bold">{SEEK_STEP}</span>
      </span>
    </IconButton>
  )
}

export function TimeReadout({ which, fallbackDuration }: { which: 'current' | 'duration'; fallbackDuration: number }) {
  const duration = useApp((s) => s.duration || fallbackDuration)
  const time = useApp((s) => (which === 'current' ? s.currentTime : duration))
  const long = duration >= 3600
  return (
    <span
      className={clsx(
        'shrink-0 font-mono text-xs tabular-nums sm:text-[13px]',
        which === 'current' ? 'text-right text-text' : 'text-left text-muted',
        long ? 'w-[7ch]' : 'w-[5ch]',
      )}
    >
      {formatTime(time, duration)}
    </span>
  )
}

export function SpeedMenu() {
  const t = useT()
  const rate = useApp((s) => s.playbackRate)
  const setSetting = useApp((s) => s.setSetting)
  return (
    <Menu
      label={t('core.player.speed')}
      side="top"
      align="end"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          title={`${t('core.player.speed')} (, .)`}
          aria-label={`${t('core.player.speed')}: ${formatSpeed(rate)}`}
          className={clsx(
            'inline-flex h-9 min-w-14 items-center justify-center gap-1 rounded-xl px-2 font-mono text-[13px] tabular-nums transition-colors',
            'hover:bg-surface-3',
            rate !== 1 ? 'text-accent' : 'text-muted hover:text-text',
          )}
        >
          <Gauge className="size-4 shrink-0" aria-hidden="true" />
          <motion.span key={rate} initial={{ scale: 1.25 }} animate={{ scale: 1 }} transition={{ duration: 0.18 }}>
            {formatSpeed(rate)}
          </motion.span>
        </button>
      )}
    >
      <MenuLabel>{t('core.player.speedHint')}</MenuLabel>
      {[...SPEEDS].reverse().map((s) => (
        <MenuItem key={s} checked={Math.abs(s - rate) < 0.001} onSelect={() => setSetting('playbackRate', s)}>
          <span className="font-mono tabular-nums">{formatSpeed(s)}</span>
          {s === 1 && <span className="ml-2 text-faint">{t('core.player.normal')}</span>}
        </MenuItem>
      ))}
    </Menu>
  )
}

export function VolumeControl() {
  const t = useT()
  const volume = useApp((s) => s.volume)
  const muted = useApp((s) => s.muted)
  const setSetting = useApp((s) => s.setSetting)
  const effective = muted ? 0 : volume
  const Icon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2
  return (
    <div className="flex items-center">
      <IconButton
        label={muted ? t('core.player.unmute') : t('core.player.mute')}
        hint="M"
        onClick={() => {
          if (muted || volume === 0) {
            if (volume === 0) setSetting('volume', 0.8)
            setSetting('muted', false)
          } else setSetting('muted', true)
        }}
      >
        <Icon className="size-[18px]" />
      </IconButton>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={effective}
        aria-label={t('core.player.volume')}
        onChange={(e) => {
          const v = Number(e.target.value)
          setSetting('volume', v)
          if (muted && v > 0) setSetting('muted', false)
        }}
        className="hidden h-1 w-20 cursor-pointer accent-accent md:block"
      />
    </div>
  )
}

export function LoopChip() {
  const t = useT()
  const loop = useApp((s) => s.loop)
  if (!loop) return null
  return (
    <button
      type="button"
      onClick={() => useApp.getState().setLoop(null)}
      title={`${t('core.player.loopClear')} (Esc)`}
      aria-label={t('core.player.loopClearAria', { from: formatTime(loop.start), to: formatTime(loop.end) })}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft pr-1.5 pl-2.5 text-xs text-accent transition-colors hover:border-accent"
    >
      <Repeat className="size-3.5" aria-hidden="true" />
      <span className="hidden font-mono tabular-nums sm:inline">
        {formatTime(loop.start)}–{formatTime(loop.end)}
      </span>
      <X className="size-3.5" aria-hidden="true" />
    </button>
  )
}

export function VideoToggle({ trackId }: { trackId: string }) {
  const t = useT()
  const showVideo = useApp((s) => s.showVideo)
  const blocked = usePlayerUi((s) => Boolean(s.blocked[trackId]))
  const label = blocked ? t('core.video.unavailable') : showVideo ? t('core.video.hide') : t('core.video.show')
  return (
    <button
      type="button"
      disabled={blocked}
      aria-pressed={showVideo && !blocked}
      onClick={() => useApp.getState().setSetting('showVideo', !showVideo)}
      title={label}
      aria-label={label}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-sm transition-colors disabled:opacity-40',
        showVideo && !blocked ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-3 hover:text-text',
      )}
    >
      <Video className="size-[18px]" aria-hidden="true" />
      <span className="hidden lg:inline">{t('core.video.short')}</span>
    </button>
  )
}
