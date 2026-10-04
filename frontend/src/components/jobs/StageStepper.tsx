import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useT } from '../../i18n'
import type { JobStatus } from '../../types'
import { stepIndex } from './stages'

const STEPS = ['download', 'decode', 'analyze'] as const


/** Download → Decode → Analyze. `failedAt` marks the step where an error happened. */
export function StageStepper({ status, failedAt }: { status: JobStatus; failedAt?: number }) {
  const t = useT()
  const current = status === 'error' ? (failedAt ?? 0) : stepIndex(status)
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label={t('core.job.steps')}>
      {STEPS.map((step, i) => {
        const done = i < current
        const active = i === current && status !== 'error'
        const failed = status === 'error' && i === current
        return (
          <li key={step} className="flex flex-col gap-2" aria-current={active ? 'step' : undefined}>
            <div
              className={clsx(
                'h-1 rounded-full transition-colors duration-300',
                done ? 'bg-accent' : active ? 'bg-accent/50' : failed ? 'bg-danger' : 'bg-surface-3',
              )}
            />
            <div className="flex items-center gap-1.5 text-sm">
              <span
                className={clsx(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  done && 'bg-accent text-accent-fg',
                  active && 'bg-accent-soft text-accent ring-1 ring-accent/60',
                  failed && 'bg-danger/15 text-danger ring-1 ring-danger/50',
                  !done && !active && !failed && 'bg-surface-3 text-faint',
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : i + 1}
              </span>
              <span className={clsx('truncate', done || active ? 'text-text' : failed ? 'text-danger' : 'text-faint')}>
                {t(`core.step.${step}`)}
              </span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
