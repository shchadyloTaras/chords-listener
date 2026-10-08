import type { Job, JobStatus } from '../../types'

/** Processing stages in order; `stepIndex` / `failedStep` count along this list. */
export const STAGES = ['download', 'decode', 'analyze'] as const
export type StageKey = (typeof STAGES)[number]

/** Stages a job goes through: an upload or recording is already here, so it has no download. */
export function stepsFor(job: Pick<Job, 'source'>): StageKey[] {
  return job.source?.type === 'file' ? STAGES.filter((s) => s !== 'download') : [...STAGES]
}

/** Overall progress where the download ends and decoding begins (SPEC progress mapping). */
const DOWNLOAD_END = 0.35

/**
 * 0 download · 1 decode · 2 analyze · 3 done (-1 for error). A `queued` job with the download's progress behind it
 * (a YouTube fragment waiting for an analysis worker) has finished the download stage.
 */
export function stepIndex(status: JobStatus, progress = 0): number {
  switch (status) {
    case 'queued':
      return progress >= DOWNLOAD_END ? 1 : 0
    case 'downloading':
      return 0
    case 'decoding':
      return 1
    case 'analyzing':
      return 2
    case 'done':
      return 3
    default:
      return -1
  }
}

/** Step a failed job stopped at, derived from its overall progress (SPEC progress mapping). */
export function failedStep(job: Pick<Job, 'progress'>): number {
  if (job.progress < DOWNLOAD_END) return 0
  if (job.progress < 0.45) return 1
  return 2
}
