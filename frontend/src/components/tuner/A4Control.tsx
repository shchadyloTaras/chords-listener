// «Еталон A4»: − / + by 1 Hz and a number to type; the typed value counts on Enter or leaving the field
// (clamped to 400..480), so a half-typed "4" never retunes everything to 400 Hz.

import { Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { A4_MAX, A4_MIN, clampA4 } from '../../lib/tuner/notes'
import { IconButton } from '../ui/IconButton'

export function A4Control({ value, onChange }: { value: number; onChange(hz: number): void }) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const typed = Number(draft.replace(',', '.'))
    setDraft(null)
    if (draft.trim() && Number.isFinite(typed)) onChange(clampA4(typed))
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 text-sm text-muted">{t('tuner.a4.label')}</span>
      <IconButton size="sm" label={t('tuner.a4.lower')} disabled={value <= A4_MIN} onClick={() => onChange(clampA4(value - 1))}>
        <Minus className="size-4" />
      </IconButton>
      <input
        type="text"
        inputMode="decimal"
        aria-label={t('tuner.a4.label')}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setDraft(null)
        }}
        className="h-8 w-14 rounded-lg border border-border-strong bg-surface text-center font-mono text-sm tabular-nums text-text focus-visible:border-accent"
      />
      <IconButton size="sm" label={t('tuner.a4.higher')} disabled={value >= A4_MAX} onClick={() => onChange(clampA4(value + 1))}>
        <Plus className="size-4" />
      </IconButton>
      <span className="text-sm text-muted">{t('tuner.hz')}</span>
    </div>
  )
}
