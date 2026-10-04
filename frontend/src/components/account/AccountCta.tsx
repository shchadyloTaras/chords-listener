import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { useT } from '../../i18n'
import { openAuthDialog } from '../../lib/auth'
import { Button } from '../ui/IconButton'
import { useCloudInvite } from './cloudInvite'

/** «Зареєструватися» (primary) + «Увійти». */
export function AccountButtons({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  const t = useT()
  return (
    <div className={clsx('flex flex-wrap gap-2', className)}>
      <Button variant="primary" size={size} onClick={() => openAuthDialog('signUp')}>
        {t('account.signUp')}
      </Button>
      <Button variant="secondary" size={size} onClick={() => openAuthDialog('signIn')}>
        {t('account.signIn')}
      </Button>
    </div>
  )
}

/**
 * Home-page invitation for guests: the benefit in one line, sign up / sign in, and a calm note that
 * files and the microphone already work without an account.
 */
export function AccountCta({ className }: { className?: string }) {
  const t = useT()
  if (!useCloudInvite()) return null
  return (
    <section
      aria-label={t('cloud.cta.title')}
      className={clsx(
        'flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-3.5 sm:flex-row sm:items-center sm:gap-5 sm:px-5',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg">
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] leading-snug font-semibold text-text">{t('cloud.cta.benefit')}</p>
          <p className="mt-1 text-sm leading-snug text-muted">{t('cloud.cta.guest')}</p>
        </div>
      </div>
      <AccountButtons className="shrink-0 max-sm:[&>button]:flex-1" />
    </section>
  )
}
