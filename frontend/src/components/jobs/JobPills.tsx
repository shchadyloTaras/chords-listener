import clsx from 'clsx'
import { TriangleAlert, Upload } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useT } from '../../i18n'
import { selectHeaderJobs, useJobs } from '../../hooks/useJobs'
import { paths } from '../../hooks/useRoute'
import { ProgressRing } from './ProgressRing'

const MAX_PILLS = 3

const pillBase =
  'inline-flex h-8 max-w-48 shrink-0 items-center gap-2 rounded-full border px-2.5 text-xs font-medium transition-colors duration-150'

/** Running uploads / jobs (and unseen failures) as compact pills in the header. */
export function JobPills() {
  const t = useT()
  const jobs = useJobs(useShallow(selectHeaderJobs))
  const uploads = useJobs((s) => s.uploads)
  const total = jobs.length + uploads.length
  if (!total) return null

  const shownUploads = uploads.slice(0, MAX_PILLS)
  const shownJobs = jobs.slice(0, Math.max(0, MAX_PILLS - shownUploads.length))
  const extra = total - shownUploads.length - shownJobs.length

  return (
    <nav aria-label={t('core.jobs.active')} className="flex min-w-0 items-center gap-1.5">
      {shownUploads.map((u) => (
        <span
          key={u.key}
          title={`${t('core.upload.uploadingShort')}: ${u.filename}`}
          className={clsx(pillBase, 'border-border-strong bg-surface-2 text-muted')}
        >
          <Upload className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="hidden truncate md:inline">{u.filename}</span>
          <span className="font-mono tabular-nums">{Math.round(u.progress * 100)}%</span>
        </span>
      ))}
      {shownJobs.map((job) => {
        const failed = job.status === 'error'
        const name = job.title || job.source?.filename || t('core.jobs.untitled')
        return (
          <a
            key={job.id}
            href={`#${paths.job(job.id)}`}
            title={failed ? `${name}: ${t('core.jobs.failed')}` : `${name}: ${t(`core.stage.${job.status}`)}`}
            className={clsx(
              pillBase,
              failed
                ? 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/15'
                : 'border-border-strong bg-surface-2 text-muted hover:bg-surface-3 hover:text-text',
            )}
          >
            {failed ? (
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ProgressRing progress={job.status === 'queued' ? null : job.progress} className="text-accent" />
            )}
            <span className="hidden truncate md:inline">{name}</span>
            {!failed && <span className="font-mono tabular-nums">{Math.round(job.progress * 100)}%</span>}
            <span className="sr-only">{failed ? t('core.jobs.failed') : t(`core.stage.${job.status}`)}</span>
          </a>
        )
      })}
      {extra > 0 && <span className="text-xs text-faint">+{extra}</span>}
    </nav>
  )
}
