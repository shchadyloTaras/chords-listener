// API shapes — source of truth shared by backend (camelCase JSON) and frontend.

export type JobStatus = 'queued' | 'downloading' | 'decoding' | 'analyzing' | 'done' | 'error'

export type ErrorCode =
  | 'invalid_url'
  | 'download_failed'
  | 'unsupported_format'
  | 'too_long'
  | 'too_large'
  | 'analysis_failed'
  | 'not_found'
  | 'internal'
  /** cloud: missing/invalid Firebase ID token */
  | 'unauthorized'
  /** cloud: per-user daily limit reached */
  | 'quota_exceeded'
  /** YouTube refused the server download (bot check) — the client should offer "listen in the tab" */
  | 'download_blocked'
  /** the requested feature is not installed on this server (e.g. vocal transcription) */
  | 'unavailable'
  /** the user cancelled the job (POST /api/jobs/{id}/cancel) */
  | 'cancelled'
  /** admission gate (docs/features/admin): the account is under a cloud restriction or a scheduled deletion */
  | 'cloud_restricted'
  /** a service switch refuses the job: analyses paused / YouTube off / vocals off */
  | 'analyses_paused'
  | 'youtube_disabled'
  | 'vocals_disabled'
  /** admin API: input errors (never journaled) */
  | 'query_too_short'
  | 'invalid_period'
  | 'invalid_value'
  | 'confirm_email_mismatch'
  /** admin API: the login is older than 15 minutes — sign in again, then repeat */
  | 'reauth_required'
  /** admin API: refused state changes (journaled as rejected) */
  | 'self_target'
  | 'deletion_pending'
  | 'not_scheduled'
  | 'not_set'
  | 'deletion_rate_limit'
  /** admin API: the journal write failed — nothing changed / nothing is shown, retry */
  | 'not_applied'
  | 'audit_unavailable'

/** A fragment of a YouTube video, in video seconds (docs/CLOUD.md → YouTube clips). */
export interface ClipRange {
  start: number
  end: number
}

export interface Job {
  id: string
  /** 'analysis' (default): chords for a new/re-analyzed track; 'vocals': vocal separation + melody */
  kind?: 'analysis' | 'vocals'
  status: JobStatus
  /** overall 0..1 */
  progress: number
  /** short human-readable stage message (English) */
  message: string
  error?: string | null
  errorCode?: ErrorCode | null
  trackId?: string | null
  /** known as soon as metadata is fetched */
  title?: string | null
  thumbnail?: string | null
  source?: TrackSource | null
  /** a YouTube fragment job: the range asked for (exact once the fragment is downloaded) */
  clip?: ClipRange | null
  createdAt: string
}

export type SourceType = 'youtube' | 'url' | 'file'

export interface TrackSource {
  type: SourceType
  url?: string | null
  videoId?: string | null
  filename?: string | null
}

export interface KeyInfo {
  /** sharp spelling, e.g. "A", "F#" */
  tonic: string
  mode: 'major' | 'minor'
  /** e.g. "Am", "F#" */
  name: string
  confidence: number
}

/** canonical quality names, see docs/SPEC.md */
export type ChordQuality =
  | 'maj' | 'min' | '7' | 'maj7' | 'min7' | 'dim' | 'aug' | 'sus2' | 'sus4'
  | 'dim7' | 'hdim7' | '6' | 'min6' | '9' | 'add9'

export interface ChordSegment {
  start: number
  end: number
  /** e.g. "C#m7", "G/B", or "N" for no chord */
  label: string
  root: string | null
  quality: ChordQuality | string | null
  bass?: string | null
  /** 0..1 */
  confidence: number
}

export interface TrackSummary {
  id: string
  title: string
  artist?: string | null
  duration: number
  thumbnail?: string | null
  source: TrackSource
  key?: KeyInfo | null
  tempo?: number | null
  chordCount?: number | null
  edited?: boolean
  /** vocal melody has been transcribed (GET /api/tracks/{id}/vocals) */
  vocals?: boolean
  /** separated stems available under /api/tracks/{id}/stems/{name}: 'vocals' | 'instruments' */
  stems?: string[]
  /**
   * A fragment of a YouTube video (the cloud downloaded only these seconds): the player starts the video at
   * `clip.start` and stops at `clip.end`; the track is also a recording linked to the video (`startOffset`).
   */
  clip?: ClipRange | null
  createdAt: string
  /** cloud only: bumps with every change of the track, as published to the live library (lib/cloud/library) */
  version?: number
}

export interface Track extends TrackSummary {
  /** server-relative; on the cloud API a signed URL (`?u=&exp=&sig=`, valid 12 h) that <audio> can load without headers */
  audioUrl: string
  timeSignature: number
  beats: number[]
  downbeats: number[]
  chords: ChordSegment[]
  /** ~1200 peaks 0..1 */
  waveform: number[]
  engine: string
  /**
   * Recording linked to a video (POST /api/jobs/storage with startOffset): every time in this track is video
   * time; the audio file starts at this video time (audio time = track time − startOffset). Chords cover
   * 0..startOffset with an "N" segment.
   */
  startOffset?: number | null
  /** signed stem URLs on the cloud API, keyed by stem name ('vocals' | 'instruments'); audio time like audioUrl */
  stemUrls?: Record<string, string> | null
}

/** POST /api/jobs/storage (cloud): analyze a file the client uploaded to Firebase Storage. */
export interface StorageJobRequest {
  /** object path, must start with `users/<uid>/uploads/` (the server deletes the object once read) */
  path: string
  title?: string | null
  /** 'youtube': a recording of this video (tab capture) — the track is linked to it (thumbnail, title, embed) */
  source?: { type: 'youtube'; videoId: string; url?: string | null } | { type: 'file'; filename?: string | null } | null
  /** video time (s) where the recording starts; all analysis times are shifted by it */
  startOffset?: number | null
  options?: { separate?: boolean } | null
}

export interface QuotaUsage {
  used: number
  limit: number
}

/** GET /api/me: the caller on the cloud API and today's (UTC) usage; `uid: null, cloud: false` on a local server. */
export interface UserInfo {
  uid: string | null
  cloud: boolean
  quotas?: { day: string; analyses: QuotaUsage; vocals: QuotaUsage; jobs: QuotaUsage } | null
}

export interface EngineInfo {
  name: string
  version: string
  features: Record<string, boolean>
}

export interface Health {
  ok: boolean
  engine: EngineInfo
  ytdlp: string | null
  ffmpeg: boolean
}

export interface ApiError {
  detail: string
  code: ErrorCode
}

/**
 * Notes transcribed from a track's audio (live piano), stored compactly per track:
 * `notes` rows are [start s, end s, MIDI 21..108, velocity 0..1], sorted by start, times rounded to ms.
 */
export interface TrackNotes {
  version: 1
  /** transcription engine + settings, e.g. "basic-pitch 1.0.1 (onset 0.5, frame 0.3, min 80 ms)" */
  engine: string
  notes: [number, number, number, number][]
}

/**
 * Sung melody transcribed from the separated vocal stem. `notes` rows use the TrackNotes layout:
 * [start s, end s, MIDI (integer, after removing the singer's global tuning offset), velocity 0..1].
 */
export interface VocalNotes {
  version: 1
  /** e.g. "htdemucs + torchcrepe-tiny 0.0.24 (seg v1)" */
  engine: string
  /** singer's global tuning vs A440 in cents (−50..50); notes are already corrected by it */
  tuningCents: number
  notes: [number, number, number, number][]
  /** raw f0 for drawing: fractional MIDI per frame (null = unvoiced), frame i at start + i·hop seconds */
  contour?: { start: number; hop: number; midi: (number | null)[] } | null
  /** lowest / highest sung MIDI note */
  range?: { low: number; high: number } | null
}

// ------------------------------------------------------------------ admin API (docs/features/admin, contracts/openapi.yaml)
// JSON is camelCase; timestamps are ISO strings; UtcDay is "YYYY-MM-DD".

export type AdminOrigin = 'link' | 'file' | 'mic' | 'tab'
/** a job's source for the history filter: a YouTube video, or anything else */
export type AdminSourceType = 'youtube' | 'other'
export type AdminJobKind = 'analysis' | 'vocals'
export type AdminHistoryStatus = 'running' | 'done' | 'error'
export type AdminFailureReason =
  | 'youtube_blocked'
  | 'download_failed'
  | 'unsupported_format'
  | 'too_long'
  | 'too_large'
  | 'analysis_failed'
  | 'other'
/** failure reason → count; an absent reason is 0 */
export type AdminReasonCounts = Partial<Record<AdminFailureReason, number>>
export type AdminAuditAction =
  | 'search'
  | 'view_card'
  | 'quota_reset'
  | 'limit_set'
  | 'limit_removed'
  | 'restrict'
  | 'unrestrict'
  | 'deletion_scheduled'
  | 'deletion_cancelled'
  | 'defaults_changed'
  | 'switch_changed'
  | 'banner_changed'
export type AdminAuditOutcome = 'applied' | 'rejected' | 'not_applied'
export type AdminAccountStatus = 'normal' | 'restricted' | 'deletion_scheduled'
export type AdminSwitchName = 'analysesPaused' | 'youtubeEnabled' | 'vocalsEnabled'

export interface AdminOriginCounts {
  link: number
  file: number
  mic: number
  tab: number
}

export interface AdminQuotaUsage {
  used: number
  limit: number
}

export interface AdminUserQuotas {
  day: string
  analyses: AdminQuotaUsage
  vocals: AdminQuotaUsage
  jobs: AdminQuotaUsage
}

export interface AdminSwitches {
  analysesPaused: boolean
  youtubeEnabled: boolean
  vocalsEnabled: boolean
}

export interface AdminDefaultLimits {
  analyses: number
  vocals: number
  jobs: number
  maxDurationMin: number
  maxUploadMb: number
}

export interface AdminBanner {
  enabled: boolean
  uk: string
  en: string
}

export interface AdminRunningJob {
  id: string
  uid: string
  email: string | null
  service: boolean
  kind: AdminJobKind
  origin: AdminOrigin
  acceptedAt: string
}

export interface AdminOverview {
  day: string
  analyses: AdminOriginCounts
  vocals: number
  failed: number
  failedByReason: AdminReasonCounts
  active: number
  newUsers: number
  runningJobs: AdminRunningJob[]
  switches: AdminSwitches
}

export interface AdminUserSearchItem {
  uid: string
  email: string
  service: boolean
}

export interface AdminUserSearchResult {
  query: string
  items: AdminUserSearchItem[]
  /** more than 50 matches — refine the query */
  truncated: boolean
}

export interface AdminRestriction {
  reason: string
  since: string
  byAdminUid: string
}

export interface AdminDeletion {
  scheduledAt: string
  purgeAfter: string
  byAdminUid: string
}

export interface AdminPersonalLimit {
  analyses: number | null
  vocals: number | null
  jobs: number | null
  until: string | null
  setAt: string
  byAdminUid: string
  expired: boolean
}

/** at least one of analyses / vocals / jobs; `until` = last UTC day included (null / absent = no end date) */
export interface AdminPersonalLimitInput {
  analyses?: number
  vocals?: number
  jobs?: number
  until?: string | null
}

/** The admin state of one account; every user action returns it. */
export interface AdminAccountState {
  uid: string
  status: AdminAccountStatus
  restriction: AdminRestriction | null
  deletion: AdminDeletion | null
  personalLimit: AdminPersonalLimit | null
  quota: AdminUserQuotas
}

export interface AdminUserProfile {
  uid: string
  email: string
  createdAt: string
  lastLoginAt: string | null
  service: boolean
  trackCount: number
  storageBytes: number
}

/** Metadata only — never audio, chords, edits, notes or media URLs. `title` is user text: render as text. */
export interface AdminTrackMeta {
  id: string
  title: string
  sourceType: 'youtube' | 'url' | 'file'
  createdAt: string
  duration: number
  edited: boolean
  vocals: boolean
  sizeBytes: number | null
}

export interface AdminPage<T> {
  items: T[]
  hasNext: boolean
  hasPrev: boolean
  nextCursor: string | null
}

export interface AdminJobHistoryItem {
  id: string
  uid: string
  email: string | null
  userDeleted: boolean
  service: boolean
  kind: AdminJobKind
  origin: AdminOrigin
  sourceType: AdminSourceType
  status: AdminHistoryStatus
  reason: AdminFailureReason | null
  errorText: string | null
  title: string | null
  acceptedAt: string
  finishedAt: string | null
}

export interface AdminJobHistoryPage extends AdminPage<AdminJobHistoryItem> {
  countsByReason: AdminReasonCounts
}

export interface AdminUserCard {
  profile: AdminUserProfile
  account: AdminAccountState
  recentJobs: AdminJobHistoryItem[]
  tracks: AdminPage<AdminTrackMeta>
}

export interface AdminStatsDay {
  day: string
  state: 'live' | 'frozen' | 'restored'
  analyses: AdminOriginCounts
  vocals: number
  failed: number
  failedByReason: AdminReasonCounts
  active: number
  newUsers: number | null
  restoredTracks: { youtube: number; url: number; file: number } | null
  frozenAt: string | null
}

export interface AdminStatsRange {
  from: string
  to: string
  days: AdminStatsDay[]
}

export interface AdminAuditEntry {
  id: string
  at: string
  adminUid: string
  adminEmail: string
  action: AdminAuditAction
  outcome: AdminAuditOutcome
  targetUid: string | null
  targetEmail: string | null
  targetDeleted: boolean
  setting: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  rejectReason: string | null
  query: string | null
  refId: string | null
  redactedAt: string | null
}

export interface AdminSettings {
  limits: AdminDefaultLimits
  switches: AdminSwitches
  banner: AdminBanner
  updatedAt: string
  updatedBy: string | null
}

/** Filters of the job history; `from` / `to` are UTC days, `to − from` ≤ 89. */
export interface AdminJobFilters {
  status?: AdminHistoryStatus
  reason?: AdminFailureReason
  origin?: AdminOrigin
  sourceType?: AdminSourceType
  from?: string
  to?: string
}

export interface AdminAuditFilters {
  adminUid?: string
  targetUid?: string
  action?: AdminAuditAction
}

/** Cursor paging: `after` = the previous page's nextCursor, `before` = go back from a cursor. */
export interface AdminPaging {
  after?: string
  before?: string
  limit?: number
}
