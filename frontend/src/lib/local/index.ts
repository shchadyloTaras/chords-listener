// Browser-only mode: tracks analyzed in the page and stored in IndexedDB (see lib/api.ts for routing).
export { LocalError } from './errors'
export { localRepo, setLocalRepo, createMemoryRepo, type LocalRepo, type LocalTrackRecord } from './db'
export {
  LOCAL_PREFIX,
  MAX_LOCAL_BYTES,
  MAX_LOCAL_DURATION_S,
  isLocalId,
  displayName,
  contentId,
  listLocalTracks,
  getLocalTrack,
  patchLocalTrack,
  resetLocalTrack,
  deleteLocalTrack,
  type LocalTrackPatch,
} from './tracks'
export {
  LOCAL_JOB_PREFIX,
  isLocalJobId,
  getLocalJob,
  listLocalJobs,
  startLocalUpload,
  startLocalReanalysis,
  cancelLocalTrackJobs,
  type LocalProgress,
} from './jobs'
