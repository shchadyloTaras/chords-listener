// Scale picker (the user's own handpan + well-known presets) and the "edit my handpan" button.

import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react'
import clsx from 'clsx'
import { ChevronDown, Pencil } from 'lucide-react'
import { useT } from '../../../i18n'
import { CUSTOM_SCALE_ID, HANDPAN_PRESETS, describeScale } from '../../../lib/handpan'
import { useApp } from '../../../store'
import { IconButton } from '../ui/controls'
import { useHandpanEditor } from './editorStore'
import { useHandpanScale } from './useHandpanScale'

/** Native select with the workspace look (custom chevron, theme colours). */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string; children: ReactNode }>(
  function Select({ wrapClassName, className, children, ...rest }, ref) {
    return (
      <span className={clsx('relative inline-flex min-w-0 items-center', wrapClassName)}>
        <select
          ref={ref}
          className={clsx('cw-hp-select min-w-0 cursor-pointer truncate rounded-md pr-6 outline-none focus-visible:outline-2 focus-visible:outline-accent', className)}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown size={13} aria-hidden className="pointer-events-none absolute right-1.5 text-muted" />
      </span>
    )
  },
)

export function HandpanScaleControls({ detailed = false, className }: { detailed?: boolean; className?: string }) {
  const t = useT()
  const id = useId()
  const scale = useHandpanScale()
  const setSetting = useApp((s) => s.setSetting)
  const show = useHandpanEditor((s) => s.show)
  const summary = describeScale(scale, true)
  const name = scale.name ?? t('handpan.scale.custom')

  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)}>
      <div className="inline-flex min-w-0 items-center gap-0.5 self-start rounded-lg bg-surface-2 p-0.5">
        <label htmlFor={id} className="sr-only">
          {t('handpan.scale')}
        </label>
        <Select
          id={id}
          value={scale.id}
          onChange={(e) => setSetting('handpanScale', e.target.value)}
          title={`${t('handpan.scale')}: ${name} — ${summary}`}
          wrapClassName="min-w-0"
          className="h-7 max-w-[12rem] pl-2.5 text-xs font-medium text-text hover:bg-surface-3"
        >
          <option value={CUSTOM_SCALE_ID}>{t('handpan.scale.custom')}</option>
          <optgroup label={t('handpan.scale.presets')}>
            {HANDPAN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </Select>
        <IconButton size="sm" label={t('handpan.edit')} onClick={show}>
          <Pencil size={13} />
        </IconButton>
      </div>
      {detailed && <span className="font-mono text-[11px] break-words text-faint">{summary}</span>}
    </div>
  )
}
