import { useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, Copy, Download } from 'lucide-react'
import { useT } from '../../i18n'
import { useApp, type CopyFormat } from '../../store'
import { useChordModel } from './model'
import { Floating } from './ui/Floating'
import { copyAll, downloadChords, useCopyFeedback } from './useCopy'

const FORMATS: CopyFormat[] = ['bars', 'timestamps', 'chordpro', 'unique']

/** Split button: main part copies everything in the current format; the menu picks a format or downloads. */
export function CopyButton({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const model = useChordModel()
  const format = useApp((s) => s.copyFormat)
  const setSetting = useApp((s) => s.setSetting)
  const { done, run } = useCopyFeedback()
  const [open, setOpen] = useState(false)
  const [caret, setCaret] = useState<HTMLButtonElement | null>(null)

  return (
    <div className="inline-flex shrink-0 items-stretch rounded-lg bg-accent text-accent-fg shadow-[0_1px_0_rgb(255_255_255/0.2)_inset]">
      <button
        type="button"
        onClick={() => run(() => copyAll(model))}
        title={t('chords.copy.all')}
        aria-label={t('chords.copy.all')}
        className="inline-flex h-9 items-center gap-2 rounded-l-lg pr-2.5 pl-3 text-sm font-semibold transition-[filter] hover:brightness-105 active:brightness-95"
      >
        {done ? <Check size={16} strokeWidth={2.6} /> : <Copy size={16} strokeWidth={2.2} />}
        <span className={clsx(compact && 'sr-only sm:not-sr-only')}>{t('chords.copy')}</span>
      </button>
      <span aria-hidden className="my-2 w-px bg-accent-fg/20" />
      <button
        ref={setCaret}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('chords.copy.more')}
        title={t('chords.copy.more')}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-8 items-center justify-center rounded-r-lg transition-[filter] hover:brightness-105"
      >
        <ChevronDown size={16} strokeWidth={2.4} className={clsx('transition-transform duration-150', open && 'rotate-180')} />
      </button>
      <Floating anchor={caret} open={open} onClose={() => setOpen(false)} placement="bottom-end" role="menu" ariaLabel={t('chords.copy.as')} className="w-72 p-1.5">
        <div className="px-2.5 pt-1.5 pb-1 text-xs text-faint">{t('chords.copy.as')}</div>
        {FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            role="menuitemradio"
            aria-checked={f === format}
            onClick={() => {
              setSetting('copyFormat', f)
              run(() => copyAll(model, f))
              setOpen(false)
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-3"
          >
            <span className={clsx('mt-0.5 grid size-4 shrink-0 place-items-center', f === format ? 'text-accent' : 'text-transparent')}>
              <Check size={14} strokeWidth={2.6} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(`chords.copy.format.${f}`)}</span>
              <span className="block truncate font-mono text-xs text-muted">{t(`chords.copy.sample.${f}`)}</span>
            </span>
          </button>
        ))}
        <div className="mx-2 my-1.5 h-px bg-border" />
        {(['txt', 'cho'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => {
              downloadChords(model, kind)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-3"
          >
            <Download size={15} className="text-muted" />
            {t(`chords.download.${kind}`)}
          </button>
        ))}
      </Floating>
    </div>
  )
}
