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
