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

export interface Job {
  id: string
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
  createdAt: string
}

export interface Track extends TrackSummary {
  audioUrl: string
  timeSignature: number
  beats: number[]
  downbeats: number[]
  chords: ChordSegment[]
  /** ~1200 peaks 0..1 */
  waveform: number[]
  engine: string
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
