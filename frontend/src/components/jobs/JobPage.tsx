import clsx from 'clsx'
import { ArrowLeft, FolderOpen, Globe, LogIn, RotateCcw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { toApiError, type ClientErrorCode } from '../../lib/api'
import { openAuthDialog, useAuth } from '../../lib/auth'
import type { Job } from '../../types'
import { acknowledgeJob, blockedVideoId, canRetry, ensureJob, isActiveJob, retryJob, useJobs } from '../../hooks/useJobs'
import { navigate, paths } from '../../hooks/useRoute'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { FILE_ACCEPT } from '../input/url'
import { startFiles } from '../input/startFiles'
import { Button } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { formatTime } from '../ui/format'
import { errorText, errorTitle } from './errorText'
import { ListeningBars } from './ListeningBars'
import { failedStep, stepsFor } from './stages'
import { StageStepper } from './StageStepper'

function sourceLabel(job: Job): string | null {
  const src = job.source
  if (!src) return null
  if (src.type === 'file') return src.filename ?? null
  if (!src.url) return null
  try {
    return new URL(src.url).hostname.replace(/^www\./, '')
  } catch {
    return src.url
  }
}

function useElapsed(since: string | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  const start = since ? Date.parse(since) : NaN
  return Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : 0
}

function Header({ job }: { job: Job | undefined }) {
  const active = !job || isActiveJob(job)
  if (job?.thumbnail) {
    return (
      <div className="relative aspect-video overflow-hidden bg-surface-3">
        <img src={job.thumbnail} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
        <ListeningBars active={active} className="absolute bottom-4 left-5 h-10" />
      </div>
    )
  }
  return (
    <div className="flex h-36 items-center justify-center bg-surface-2">
      <ListeningBars active={active} />
    </div>
  )
}

/** Processing view for #/job/<id>: polls, shows stages, auto-opens the track when done. */
export function JobPage({ id }: { id: string }) {
  const t = useT()
  const job = useJobs((s) => s.jobs[id])
  // errors are keyed by job id so a stale one never shows for another job
  const [failure, setFailure] = useState<{ id: string; code: ClientErrorCode } | null>(null)
  const loadError = failure?.id === id ? failure.code : null
  const [retrying, setRetrying] = useState(false)
  const [retryGone, setRetryGone] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // "Try again" after the job could not be loaded; signing in (a new user) loads it again too
  const [attempt, setAttempt] = useState(0)
  const uid = useAuth((s) => s.user?.uid)

  useEffect(() => {
    const ctrl = new AbortController()
    ensureJob(id, ctrl.signal)
      .then(() => setFailure((f) => (f?.id === id ? null : f)))
      .catch((e) => {
        const err = toApiError(e)
        if (err.code !== 'aborted') setFailure({ id, code: err.code })
      })
    return () => ctrl.abort()
  }, [id, attempt, uid])

  // YouTube refused the server download: play the video here and listen to this tab instead
  const blockedVideo = job ? blockedVideoId(job) : null
  useEffect(() => {
    if (job?.status === 'done' && job.trackId) navigate(paths.track(job.trackId), { replace: true })
    if (job?.status === 'error') acknowledgeJob(job.id)
    if (blockedVideo) navigate(paths.capture(blockedVideo, { blocked: true }), { replace: true })
  }, [job?.status, job?.trackId, job?.id, blockedVideo])

  const running = !job || isActiveJob(job)
  const elapsed = useElapsed(job?.createdAt, running)
  const pct = Math.round((job?.progress ?? 0) * 100)
  useDocumentTitle(job?.status === 'error' || loadError ? t('core.job.failedTitle') : `${pct}% · ${t('core.job.docTitle')}`)

  const errorCode: string | null = loadError ?? (job?.status === 'error' ? (job.errorCode ?? 'internal') : null)

  if (errorCode) {
    const reload = () => {
      setFailure(null)
      setAttempt((n) => n + 1)
    }
    const retry = async (opts?: { inBrowser?: boolean }) => {
      if (!job) return
      setRetrying(true)
      try {
        if (!(await retryJob(job, opts))) setRetryGone(true)
      } catch (e) {
        setFailure({ id, code: toApiError(e).code })
      } finally {
        setRetrying(false)
      }
    }
    const canRetryJob = !!job && canRetry(job) && !retryGone
    // the cloud's limit for today: an upload that is still here can be analyzed in this browser
    const canRetryHere = canRetryJob && errorCode === 'quota_exceeded' && job.source?.type === 'file'
    // an upload whose file is gone (the page was reloaded, or it went into another try): pick it again
    const fileGone = !!job && job.source?.type === 'file' && !canRetryJob
    const canReload = !job && !!loadError
    const hasAction = canRetryJob || canReload || fileGone
    return (
      <div className="mx-auto w-full max-w-xl px-4 pt-10 pb-24 sm:pt-20">
        <div role="alert" className="overflow-hidden rounded-3xl border border-border bg-surface">
          {job && <Header job={job} />}
          <div className="p-5 sm:p-7">
            <div className="flex items-start gap-3">
              <TriangleAlert className="mt-1 size-5 shrink-0 text-danger" aria-hidden="true" />
              <div className="min-w-0">
                <h1 className="font-display text-xl font-semibold tracking-tight">{errorTitle(errorCode)}</h1>
                {job?.title && <p className="mt-1 truncate text-sm text-muted">{job.title}</p>}
                <p className="mt-3 text-[15px] leading-relaxed text-text">{errorText(errorCode)}</p>
                {fileGone && <p className="mt-2 text-sm text-muted">{t('core.job.retryGone')}</p>}
                {job?.error && (
                  <details className="mt-3 text-sm text-faint">
                    <summary className="cursor-pointer select-none hover:text-muted">{t('core.job.detailsEn')}</summary>
                    <p className="mt-1.5 font-mono text-xs break-words">{job.error}</p>
                  </details>
                )}
              </div>
            </div>
            {job && job.status === 'error' && (
              <div className="mt-6">
                <StageStepper status="error" failedAt={failedStep(job)} steps={stepsFor(job)} />
              </div>
            )}
            <div className="mt-7 flex flex-wrap gap-2">
              {errorCode === 'unauthorized' && (
                <Button variant="primary" icon={<LogIn className="size-4" />} onClick={() => openAuthDialog('signIn', 'expired')}>
                  {t('account.signIn')}
                </Button>
              )}
              {canReload && (
                <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={reload}>
                  {t('core.retry')}
                </Button>
              )}
              {canRetryHere && (
                <Button
                  variant="primary"
                  disabled={retrying}
                  icon={<Globe className="size-4" />}
                  onClick={() => void retry({ inBrowser: true })}
                >
                  {t('cloud.quota.retryInBrowser')}
                </Button>
              )}
              {canRetryJob && (
                <Button
                  variant={canRetryHere ? 'secondary' : 'primary'}
                  disabled={retrying}
                  icon={<RotateCcw className={clsx('size-4', retrying && 'animate-spin')} />}
                  onClick={() => void retry()}
                >
                  {t('core.retry')}
                </Button>
              )}
              {fileGone && (
                <>
                  <Button variant="primary" icon={<FolderOpen className="size-4" />} onClick={() => fileRef.current?.click()}>
                    {t('core.input.pickFile')}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept={FILE_ACCEPT}
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.target.files?.length) startFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </>
              )}
              <Button variant={hasAction ? 'ghost' : 'primary'} onClick={() => navigate(paths.home())}>
                {t('core.job.backHome')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const stageKey = job ? `core.stage.${job.status}` : 'core.loading'
  const source = job ? sourceLabel(job) : null
  // uploads are titled after their filename: don't print it twice
  const label = source && source !== job?.title ? source : null
  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-10 pb-24 sm:pt-20">
      <div className="overflow-hidden rounded-3xl border border-border bg-surface">
        <Header job={job} />
        <div className="p-5 sm:p-7">
          <h1 className="font-display text-xl leading-snug font-semibold tracking-tight break-words sm:text-2xl">
            {job?.title || t('core.job.analyzing')}
          </h1>
          {label && (
            <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted">
              {job?.source?.type === 'youtube' && <VideoSiteIcon className="size-3.5" />}
              {label}
            </p>
          )}

          <div className="mt-7">
            <StageStepper status={job?.status ?? 'queued'} steps={stepsFor(job ?? {})} />
          </div>

          <div className="mt-6">
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label={t('core.job.progress')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-3 text-sm">
              <span aria-live="polite" className="truncate text-muted">
                {t(stageKey)}
              </span>
              <span className="shrink-0 font-mono text-muted tabular-nums">
                <span className="text-text">{pct}%</span>
                <span className="mx-2 text-faint" aria-hidden="true">
                  /
                </span>
                {formatTime(elapsed)}
              </span>
            </div>
          </div>

          <p className="mt-6 text-sm text-faint">{t('core.job.background')}</p>
        </div>
      </div>
      <Button
        variant="ghost"
        className="mt-4 -ml-1"
        icon={<ArrowLeft className="size-4" />}
        onClick={() => navigate(paths.home())}
      >
        {t('core.job.backHome')}
      </Button>
    </div>
  )
}
