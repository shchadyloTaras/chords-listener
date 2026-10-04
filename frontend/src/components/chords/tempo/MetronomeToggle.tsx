// Compact metronome on/off button for the player bar (shortcut K); while it is on, a small
// volume slider (up to 200%) sits next to it so the click can be made louder mid-song.

import clsx from 'clsx'
import { useT } from '../../../i18n'
import { useApp } from '../../../store'
import { IconButton } from '../../ui/IconButton'
import { METRONOME_MAX_VOLUME, toggleMetronome } from './metronome'
import { MetronomeIcon } from './MetronomeIcon'

export function MetronomeToggle() {
  const t = useT()
  const on = useApp((s) => s.metronome)
  const volume = useApp((s) => s.metronomeVolume)
  const setSetting = useApp((s) => s.setSetting)
  const pct = Math.round(volume * 100)
  return (
    <div className="flex items-center gap-1.5">
      <IconButton label={t('tempo.metronome')} hint="K" active={on} aria-pressed={on} onClick={() => toggleMetronome(!on)}>
        <MetronomeIcon className="size-[18px]" />
      </IconButton>
      {on && (
        <label className="hidden items-center gap-1.5 sm:flex" title={t('tempo.metronome.volume')}>
          <input
            type="range"
            min={0}
            max={METRONOME_MAX_VOLUME}
            step={0.05}
            value={volume}
            aria-label={t('tempo.metronome.volume')}
            aria-valuetext={`${pct}%`}
            onChange={(e) => setSetting('metronomeVolume', Number(e.target.value))}
            className="h-1 w-20 cursor-pointer accent-accent"
          />
          <span className={clsx('w-9 font-mono text-[11px] tabular-nums', volume > 1 ? 'text-accent' : 'text-muted')}>{pct}%</span>
        </label>
      )}
    </div>
  )
}
