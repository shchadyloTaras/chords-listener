import clsx from 'clsx'
import { CircleAlert } from 'lucide-react'
import { useT } from '../../i18n'

/** Why listening failed, with the browser's own error folded away under "Technical details". */
export function CaptureErrorAlert({ message, detail, className }: { message: string; detail: string | null; className?: string }) {
  const t = useT()
  return (
    <div role="alert" className={clsx('flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/[0.07] p-3 text-sm text-text', className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0">
        <p>{message}</p>
        {detail && (
          <details className="mt-2 text-faint">
            <summary className="cursor-pointer select-none hover:text-muted">{t('core.job.details')}</summary>
            <p className="mt-1.5 font-mono text-xs break-words">{detail}</p>
          </details>
        )}
      </div>
    </div>
  )
}
