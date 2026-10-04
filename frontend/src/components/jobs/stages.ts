import type { Job, JobStatus } from '../../types'

/** 0 download · 1 decode · 2 analyze · 3 done (-1 for error). */
export function stepIndex(status: JobStatus): number {
  switch (status) {
    case 'queued':
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
  if (job.progress < 0.35) return 0
  if (job.progress < 0.45) return 1
  return 2
}
