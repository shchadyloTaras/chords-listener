import clsx from 'clsx'
import { Check, MousePointer2 } from 'lucide-react'
import { useT } from '../../i18n'
import { LogoMark } from '../ui/Logo'

/**
 * A tiny picture of Chrome's "Share this tab?" dialog with "Also share tab audio" ticked — the one
 * thing people miss when sharing a tab's sound.
 */
export function ShareTabIllustration({ className }: { className?: string }) {
  const t = useT()
  return (
    <figure role="img" aria-label={t('cloud.capture.ill.alt')} className={clsx('select-none', className)}>
      <div aria-hidden="true" className="w-full max-w-[19rem] rounded-xl border border-border-strong bg-surface-2 p-3 text-[11px] leading-tight shadow-lg shadow-black/20">
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
          <span className="rounded-full bg-accent px-2.5 py-1 font-semibold text-accent-fg">{t('cloud.capture.ill.share')}</span>
        </div>
      </div>
    </figure>
  )
}
