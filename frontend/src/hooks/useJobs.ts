import { create } from 'zustand'
import * as api from '../lib/api'
import { toApiError, type JobOptions, type UploadMeta } from '../lib/api'
import { forgetServerJob, recentServerJobs } from '../lib/cloud/activity'
import { isLocalId } from '../lib/local'
import { useConnection, whenSettled } from '../lib/serverMode'
import { t } from '../i18n'
import { useApp } from '../store'
import type { Job, JobStatus } from '../types'
import { errorText } from '../components/jobs/errorText'
import { linkTarget, parseYouTubeId } from '../components/input/url'
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
    .filter((j) => isActiveJob(j) || (j.status === 'error' && j.errorCode !== 'cancelled' && !s.acknowledged[j.id]))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function jobTitle(job: Job): string {
  return job.title || job.source?.filename || t('core.jobs.untitled')
}

/** YouTube video of a job whose server download YouTube refused: it can be listened to in the tab instead. */
export function blockedVideoId(job: Pick<Job, 'status' | 'errorCode' | 'source'>): string | null {
  if (job.status !== 'error' || job.errorCode !== 'download_blocked' || !job.source) return null
  return job.source.videoId || (job.source.url ? parseYouTubeId(job.source.url) : null)
}

/** Where a job YouTube refused sends the user: «Слухати у вкладці» for that video, from the fragment's start. */
export function blockedPath(job: Pick<Job, 'status' | 'errorCode' | 'source' | 'clip'>): string | null {
  const videoId = blockedVideoId(job)
  return videoId ? paths.capture(videoId, { blocked: true, t: job.clip?.start }) : null
}

// ------------------------------------------------------------------ polling

/**
 * How often running jobs are polled (ms): calm, since every poll keeps a cloud instance busy; slower in a
 * hidden tab, slowest while the cloud wants a new sign-in.
 */
export const JOB_POLL_MS = { visible: 1000, hidden: 3000, signedOut: 5000 } as const
/** The first poll of a job just started / found. */
const FIRST_POLL_MS = 600

let pollTimer: number | null = null

function schedulePoll(delay: number = FIRST_POLL_MS) {
  if (pollTimer != null) return
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    void pollOnce()
  }, delay)
}

async function pollOnce() {
  const active = Object.values(useJobs.getState().jobs).filter(isActiveJob)
  if (!active.length) return
  let signedOut = false
  await Promise.all(
    active.map(async (prev) => {
      try {
        applyUpdate(prev, await api.getJob(prev.id))
      } catch (e) {
        const err = toApiError(e)
        if (err.code === 'not_found') {
          applyUpdate(prev, { ...prev, status: 'error', errorCode: 'not_found', error: err.message })
        }
        if (err.code === 'unauthorized') signedOut = true
        // network hiccups: keep polling
      }
    }),
  )
  // the cloud wants a new sign-in: check back calmly instead of hammering it
  if (Object.values(useJobs.getState().jobs).some(isActiveJob))
    schedulePoll(signedOut ? JOB_POLL_MS.signedOut : document.hidden ? JOB_POLL_MS.hidden : JOB_POLL_MS.visible)
}

function applyUpdate(prev: Job, next: Job) {
  upsert(next)
  if (!isActiveJob(prev) || isActiveJob(next)) return
  if (!isLocalId(next.id)) forgetServerJob(next.id)
  const watching = currentPath() === paths.job(next.id)
  if (watching) return // JobPage reacts itself
  const { toast } = useApp.getState()
  if (next.status === 'done' && next.trackId) {
    const trackId = next.trackId
    toast(t('core.jobs.readyToast', { title: jobTitle(next) }), 'success', {
      label: t('core.jobs.open'),
      run: () => navigate(paths.track(trackId)),
    })
  } else if (next.status === 'error' && next.errorCode !== 'cancelled') {
    const blocked = blockedPath(next)
    if (blocked) {
      toast(`${jobTitle(next)}: ${t('cloud.blocked.toast')}`, 'info', {
        label: t('cloud.blocked.action'),
        run: () => navigate(blocked),
      })
      return
    }
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

/** Drops the jobs of a server that is no longer connected (e.g. the cloud after signing out). */
export function forgetServerJobs(): void {
  useJobs.setState((s) => {
    const jobs: Record<string, Job> = {}
    for (const [id, job] of Object.entries(s.jobs)) if (isLocalId(id)) jobs[id] = job
    return { jobs }
  })
}

// Another server (or none) now answers: its jobs are not ours to poll; pick up the new one's running jobs.
useConnection.subscribe((s, prev) => {
  if (s.apiBase === prev.apiBase) return
  if (prev.apiBase) forgetServerJobs()
  if (s.status === 'server') void syncServerJobs()
})

let syncing: Promise<void> | null = null

/**
 * Picks up jobs that are still running on the server (e.g. after a page reload). Asks the server only when a
 * job started on this device in the last hours may still run (lib/cloud/activity): every request wakes the
 * cloud, and an idle page must not.
 */
export function syncServerJobs(): Promise<void> {
  if (!recentServerJobs().length) return Promise.resolve()
  syncing ??= doSyncServerJobs().finally(() => (syncing = null))
  return syncing
}

async function doSyncServerJobs(): Promise<void> {
  try {
    const conn = await whenSettled()
    // what the listing can tell about: a job started after the request went out is not in it
    const remembered = recentServerJobs()
    const jobs = await api.listJobs()
    const running = jobs.filter(isActiveJob)
    let finished: Job[] = []
    // the ones that are over (or unknown to this server) need no looking for after the next reload — only when
    // a server answered (not browser mode while the session is still being restored) and is still the one
    const now = useConnection.getState()
    if (conn.status === 'server' && now.status === 'server' && now.apiBase === conn.apiBase) {
      const runningIds = new Set(running.map((j) => j.id))
      for (const id of remembered) if (!runningIds.has(id)) forgetServerJob(id)
      // done while the page was away: a new (or changed) song — the song list hears of it like of any finished job
      finished = jobs.filter((j) => j.status === 'done' && remembered.includes(j.id) && useJobs.getState().jobs[j.id]?.status !== 'done')
    }
    if (!running.length && !finished.length) return
    useJobs.setState((s) => {
      const next = { ...s.jobs }
      for (const j of [...running, ...finished]) next[j.id] = j
      return { jobs: next }
    })
    if (running.length) schedulePoll()
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
export async function submitUrl(url: string, options?: JobOptions, signal?: AbortSignal): Promise<Job> {
  const fromPath = currentPath()
  const job = await api.createJob(url, options, signal)
  upsert(job)
  follow(job, fromPath)
  return job
}

/** Starts a YouTube fragment on the cloud and follows its job (navigates to it). Throws ApiError. */
export async function submitClip(videoId: string, start: number, signal?: AbortSignal): Promise<Job> {
  const fromPath = currentPath()
  const job = await api.createClipJob(videoId, start, signal)
  upsert(job)
  follow(job, fromPath)
  return job
}

let uploadSeq = 0

export interface SubmitFileExtra {
  /** title / source / start offset of the recording (see api.UploadMeta) */
  meta?: UploadMeta
  /** analyze in this browser even when a server is connected */
  inBrowser?: boolean
  signal?: AbortSignal
}

/**
 * Uploads a file with progress (shown in the header / home input), then follows its job (navigates to it
 * unless the user went elsewhere meanwhile). Throws ApiError; see submitFile for the toasting variant.
 */
export async function uploadAndFollow(file: File, options?: JobOptions, extra: SubmitFileExtra = {}): Promise<Job> {
  const key = `upload-${++uploadSeq}`
  const ctrl = new AbortController()
  const outer = extra.signal
  const onOuterAbort = () => ctrl.abort()
  if (outer?.aborted) ctrl.abort()
  else outer?.addEventListener('abort', onOuterAbort, { once: true })
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
      { options, signal: ctrl.signal, meta: extra.meta, inBrowser: extra.inBrowser },
    )
    rememberFile(job.id, file)
    upsert(job)
    follow(job, fromPath)
    return job
  } finally {
    outer?.removeEventListener('abort', onOuterAbort)
    useJobs.setState((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) }))
  }
}

/** Uploads a file with progress (shown in the header / home input) and navigates to its job; failures toast. */
export async function submitFile(file: File, options?: JobOptions, extra: SubmitFileExtra = {}): Promise<Job | null> {
  try {
    return await uploadAndFollow(file, options, extra)
  } catch (e) {
    const err = toApiError(e)
    const { toast } = useApp.getState()
    if (err.code === 'aborted') toast(t('core.upload.cancelled'), 'info')
    else if (err.code === 'quota_exceeded' && !extra.inBrowser)
      // the cloud's limit for today: this browser can still do it
      toast(`${file.name}: ${errorText(err.code)}`, 'error', {
        label: t('cloud.quota.inBrowser'),
        run: () => void submitFile(file, options, { ...extra, inBrowser: true }),
      })
    else toast(`${file.name}: ${errorText(err.code)}`, 'error')
    return null
  }
}

/** Whether "Retry" can recreate this job (URL source, or the uploaded file is still in memory). */
export function canRetry(job: Job): boolean {
  return Boolean((job.source?.type !== 'file' && job.source?.url) || retryFiles.has(job.id))
}

/**
 * Re-submits a failed job. Returns false when the source is no longer available. `inBrowser` analyzes an
 * upload in this browser instead of the server (e.g. after the cloud's limit for today).
 */
export async function retryJob(job: Job, opts?: { inBrowser?: boolean }): Promise<boolean> {
  acknowledgeJob(job.id)
  const file = retryFiles.get(job.id)
  if (job.source?.type !== 'file' && job.source?.url) {
    const { url } = job.source
    const conn = useConnection.getState()
    const target = linkTarget(url, conn)
    // a YouTube video: signed in, the fragment picker (at the fragment this job asked for); a guest listens in the tab
    if (target === 'clip' || target === 'capture' || target === 'notVideo') {
      const videoId = job.source.videoId ?? parseYouTubeId(url)
      if (!videoId) return false
      const onCloud = conn.status === 'server' && conn.backend === 'cloud'
      navigate(onCloud ? paths.clip(videoId, { t: job.clip?.start }) : paths.capture(videoId))
      return true
    }
    await submitUrl(url)
    return true
  }
  if (file) {
    retryFiles.delete(job.id)
    return (await submitFile(file, undefined, opts?.inBrowser ? { inBrowser: true } : undefined)) !== null
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
