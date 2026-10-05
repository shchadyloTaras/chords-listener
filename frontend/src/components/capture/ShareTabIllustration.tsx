import clsx from 'clsx'
import { Check, MousePointer2 } from 'lucide-react'
import { useT } from '../../i18n'
import { LogoMark } from '../ui/Logo'

/**
 * A tiny picture of Chrome's "Share this tab?" dialog with "Also share tab audio" ticked — the one
 * thing people miss when sharing a tab's sound. It is captioned as an example and drawn dashed, faded
 * and with an outlined "Share", so it does not pass for a dialog to click (the only filled button on
 * the page is the real "Start").
 */
export function ShareTabIllustration({ className }: { className?: string }) {
  const t = useT()
  return (
    <figure className={clsx('select-none', className)}>
      <figcaption className="mb-2 max-w-[19rem] text-xs leading-snug text-faint">{t('cloud.capture.example')}</figcaption>
      <div
        role="img"
        aria-label={t('cloud.capture.ill.alt')}
        className="w-full max-w-[19rem] rounded-xl border border-dashed border-border-strong bg-surface-2 p-3 text-[11px] leading-tight opacity-80 shadow-lg shadow-black/20"
      >
        <p className="text-[12px] font-semibold text-text">{t('cloud.capture.ill.title')}</p>
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-bg/60 p-1.5">
          <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-surface-3">
            <LogoMark className="size-5" />
          </span>
          <span className="truncate text-muted">{t('cloud.capture.ill.tab')}</span>
        </div>
        <div className="relative mt-2 flex items-center gap-2 rounded-md bg-accent-soft px-1.5 py-1.5 ring-2 ring-accent">
          <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-accent text-accent-fg">
            <Check className="size-3" strokeWidth={3.5} />
          </span>
          <span className="font-medium text-text">{t('cloud.capture.ill.audio')}</span>
          <MousePointer2 className="absolute -right-1.5 -bottom-2.5 size-4 rotate-[-8deg] fill-text text-bg" />
        </div>
        <div className="mt-2.5 flex justify-end gap-1.5">
          <span className="rounded-full border border-border-strong px-2.5 py-1 text-muted">{t('cloud.capture.ill.cancel')}</span>
          <span className="rounded-full border border-border-strong px-2.5 py-1 font-semibold text-muted">{t('cloud.capture.ill.share')}</span>
        </div>
      </div>
    </figure>
  )
}
