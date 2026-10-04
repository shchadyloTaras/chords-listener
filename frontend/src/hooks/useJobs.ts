import { create } from 'zustand'
import * as api from '../lib/api'
import { toApiError, type JobOptions } from '../lib/api'
import { t } from '../i18n'
import { useApp } from '../store'
import type { Job, JobStatus } from '../types'
import { errorText } from '../components/jobs/errorText'
import { currentPath, navigate, paths } from './useRoute'

const ACTIVE: ReadonlySet<JobStatus> = new Set<JobStatus>(['queued', 'downloading', 'decoding', 'analyzing'])

export function isActiveJob(job: Pick<Job, 'status'>): boolean {
  return ACTIVE.has(job.status)
}

export interface UploadEntry {
  key: string
  filename: string
  size: number
  /** 0..1 */
  progress: number
  cancel(): void
}

interface JobsState {
  jobs: Record<string, Job>
  /** failed jobs the user has already looked at (hidden from the header) */
  acknowledged: Record<string, true>
  uploads: UploadEntry[]
}

export const useJobs = create<JobsState>()(() => ({ jobs: {}, acknowledged: {}, uploads: [] }))

/** Original files of upload jobs, kept for "Retry" (most recent few only). */
const retryFiles = new Map<string, File>()
const MAX_RETRY_FILES = 6

function rememberFile(jobId: string, file: File) {
  retryFiles.set(jobId, file)
  while (retryFiles.size > MAX_RETRY_FILES) retryFiles.delete(retryFiles.keys().next().value as string)
}

function upsert(job: Job) {
  useJobs.setState((s) => ({ jobs: { ...s.jobs, [job.id]: job } }))
}

export function acknowledgeJob(id: string) {
  if (useJobs.getState().acknowledged[id]) return
  useJobs.setState((s) => ({ acknowledged: { ...s.acknowledged, [id]: true } }))
}

/** Jobs to surface in the header: running ones and failures not yet seen. Newest first. */
export function selectHeaderJobs(s: JobsState): Job[] {
  return Object.values(s.jobs)
    .filter((j) => isActiveJob(j) || (j.status === 'error' && !s.acknowledged[j.id]))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function jobTitle(job: Job): string {
  return job.title || job.source?.filename || t('core.jobs.untitled')
}

// ------------------------------------------------------------------ polling

let pollTimer: number | null = null

function schedulePoll(delay = 400) {
  if (pollTimer != null) return
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    void pollOnce()
  }, delay)
}

async function pollOnce() {
  const active = Object.values(useJobs.getState().jobs).filter(isActiveJob)
  if (!active.length) return
  await Promise.all(
    active.map(async (prev) => {
      try {
        applyUpdate(prev, await api.getJob(prev.id))
      } catch (e) {
        const err = toApiError(e)
        if (err.code === 'not_found') {
          applyUpdate(prev, { ...prev, status: 'error', errorCode: 'not_found', error: err.message })
        }
        // network hiccups: keep polling
      }
    }),
  )
  if (Object.values(useJobs.getState().jobs).some(isActiveJob)) schedulePoll(document.hidden ? 1500 : 400)
}

function applyUpdate(prev: Job, next: Job) {
  upsert(next)
  if (!isActiveJob(prev) || isActiveJob(next)) return
  const watching = currentPath() === paths.job(next.id)
  if (watching) return // JobPage reacts itself
  const { toast } = useApp.getState()
  if (next.status === 'done' && next.trackId) {
    const trackId = next.trackId
    toast(t('core.jobs.readyToast', { title: jobTitle(next) }), 'success', {
      label: t('core.jobs.open'),
      run: () => navigate(paths.track(trackId)),
    })
  } else if (next.status === 'error') {
    toast(`${jobTitle(next)}: ${errorText(next.errorCode)}`, 'error', {
      label: t('core.jobs.details'),
      run: () => navigate(paths.job(next.id)),
    })
  }
}

/** Starts tracking a job (deep link / app start). Resolves with the latest state. */
export async function ensureJob(id: string, signal?: AbortSignal): Promise<Job> {
  const known = useJobs.getState().jobs[id]
  if (known) {
    if (isActiveJob(known)) schedulePoll(0)
    return known
  }
  const job = await api.getJob(id, signal)
  upsert(job)
  if (isActiveJob(job)) schedulePoll()
  return job
}

/** Picks up jobs that are still running on the server (e.g. after a page reload). */
export async function syncServerJobs(): Promise<void> {
  try {
    const jobs = await api.listJobs()
    const running = jobs.filter(isActiveJob)
    if (!running.length) return
    useJobs.setState((s) => {
      const next = { ...s.jobs }
      for (const j of running) next[j.id] = j
      return { jobs: next }
    })
    schedulePoll()
  } catch {
    /* backend down — the health banner explains it */
  }
}

// --------------------------------------------------------------- submitting

/**
 * Shows a freshly created job: straight to the track when it is already done (dedup),
 * otherwise to the processing view. If the user navigated elsewhere meanwhile (`fromPath`
 * no longer current), stays put and lets the header pill / toast do the talking.
 */
function follow(job: Job, fromPath: string) {
  if (isActiveJob(job)) schedulePoll()
  const here = currentPath()
  const replace = here.startsWith('/job/')
  if (here !== fromPath) {
    if (job.status === 'done' && job.trackId) applyUpdate({ ...job, status: 'analyzing' }, job)
    return
  }
  if (job.status === 'done' && job.trackId) {
    useApp.getState().toast(t('core.jobs.dedup'), 'info')
    navigate(paths.track(job.trackId), { replace })
  } else {
    navigate(paths.job(job.id), { replace })
  }
}

/** Creates a job for a URL and navigates to it. Throws ApiError (caller shows it inline). */
export async function submitUrl(url: string, options?: JobOptions): Promise<Job> {
  const fromPath = currentPath()
  const job = await api.createJob(url, options)
  upsert(job)
  follow(job, fromPath)
  return job
}

let uploadSeq = 0

/** Uploads a file with progress (shown in the header / home input) and navigates to its job. */
export async function submitFile(file: File, options?: JobOptions): Promise<Job | null> {
  const key = `upload-${++uploadSeq}`
  const ctrl = new AbortController()
  const fromPath = currentPath()
  const patchUpload = (patch: Partial<UploadEntry>) =>
    useJobs.setState((s) => ({ uploads: s.uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)) }))

  useJobs.setState((s) => ({
    uploads: [...s.uploads, { key, filename: file.name, size: file.size, progress: 0, cancel: () => ctrl.abort() }],
  }))

  let lastUpdate = 0
  try {
    const job = await api.uploadFile(
      file,
      (fraction) => {
        const now = performance.now()
        if (fraction < 1 && now - lastUpdate < 80) return
        lastUpdate = now
        patchUpload({ progress: fraction })
      },
      { options, signal: ctrl.signal },
    )
    rememberFile(job.id, file)
    upsert(job)
    follow(job, fromPath)
    return job
  } catch (e) {
    const err = toApiError(e)
    const { toast } = useApp.getState()
    if (err.code === 'aborted') toast(t('core.upload.cancelled'), 'info')
    else toast(`${file.name}: ${errorText(err.code)}`, 'error')
    return null
  } finally {
    useJobs.setState((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) }))
  }
}

/** Whether "Retry" can recreate this job (URL source, or the uploaded file is still in memory). */
export function canRetry(job: Job): boolean {
  return Boolean((job.source?.type !== 'file' && job.source?.url) || retryFiles.has(job.id))
}

/** Re-submits a failed job. Returns false when the source is no longer available. */
export async function retryJob(job: Job): Promise<boolean> {
  acknowledgeJob(job.id)
  const file = retryFiles.get(job.id)
  if (job.source?.type !== 'file' && job.source?.url) {
    await submitUrl(job.source.url)
    return true
  }
  if (file) {
    retryFiles.delete(job.id)
    return (await submitFile(file)) !== null
  }
  return false
}

/** Re-analyzes an existing track and opens the processing view. */
export async function reanalyze(trackId: string): Promise<Job> {
  const fromPath = currentPath()
  const job = await api.reanalyzeTrack(trackId)
  upsert(job)
  if (isActiveJob(job)) schedulePoll()
  if (currentPath() === fromPath) navigate(paths.job(job.id))
  return job
}
