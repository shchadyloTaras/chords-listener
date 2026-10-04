// Compact metronome on/off button for the player bar (shortcut K).

import { useT } from '../../../i18n'
import { useApp } from '../../../store'
import { IconButton } from '../../ui/IconButton'
import { toggleMetronome } from './metronome'
import { MetronomeIcon } from './MetronomeIcon'

export function MetronomeToggle() {
  const t = useT()
  const on = useApp((s) => s.metronome)
  return (
    <IconButton label={t('tempo.metronome')} hint="K" active={on} aria-pressed={on} onClick={() => toggleMetronome(!on)}>
      <MetronomeIcon className="size-[18px]" />
    </IconButton>
  )
}
