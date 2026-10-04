import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useApp, type Toast } from '../../store'

const icons: Record<Toast['kind'], typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
}

/** Renders store.toasts above the player bar. Polite live region; errors are assertive. */
export function Toaster() {
  const t = useT()
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4"
      style={{ bottom: 'calc(var(--player-h, 0px) + 16px)' }}
      role="region"
      aria-label={t('core.toasts')}
    >
      <div aria-live="polite" className="contents">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => {
            const Icon = icons[toast.kind]
            return (
              <motion.div
                key={toast.id}
                layout
                role={toast.kind === 'error' ? 'alert' : undefined}
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                className={clsx(
                  'pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-surface-3 py-2.5 pr-2 pl-3.5',
                  'text-sm text-text shadow-xl shadow-black/25',
                  toast.kind === 'error' ? 'border-danger/40' : 'border-border-strong',
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={clsx(
                    'size-4 shrink-0',
                    toast.kind === 'success' && 'text-success',
                    toast.kind === 'error' && 'text-danger',
                    toast.kind === 'info' && 'text-muted',
                  )}
                />
                <span className="min-w-0 flex-1 break-words">{toast.message}</span>
                {toast.action && (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg px-2.5 py-1 font-medium text-accent transition-colors hover:bg-accent-soft"
                    onClick={() => {
                      toast.action?.run()
                      dismiss(toast.id)
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('core.close')}
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-text"
                >
                  <X className="size-3.5" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}
