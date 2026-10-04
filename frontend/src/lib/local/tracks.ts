// Library of tracks analyzed in the browser (ids "local-…"), shaped exactly like the server's API objects.
import type { BrowserAnalysis } from '../engine'
import type { ChordSegment, Track, TrackSource, TrackSummary } from '../../types'
import { localRepo, requestPersistentStorage, type LocalTrackRecord } from './db'
import { LocalError } from './errors'

export const LOCAL_PREFIX = 'local-'
/** Same defaults as the server (CHORDS_MAX_UPLOAD_MB / CHORDS_MAX_DURATION_MIN). */
export const MAX_LOCAL_BYTES = 500 * 1024 * 1024
export const MAX_LOCAL_DURATION_S = 30 * 60

const MEDIA_EXT =
  /\.(mp3|m4a|aac|wav|wave|flac|ogg|oga|opus|weba|webm|mp4|m4v|mov|mkv|avi|wma|aif|aiff|caf|amr|3gp)$/i

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX)
}

/** Human title from a file name (mirrors the server): drop a media extension, underscores → spaces. */
export function displayName(filename: string): string {
  const stem = filename.replace(MEDIA_EXT, '')
  return stem.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300) || 'Untitled'
}

/** Content-derived id, so the same file is recognized again (like the server's sha1 dedup). */
export async function contentId(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer()
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return LOCAL_PREFIX + Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  // insecure context (no SubtleCrypto): FNV-1a over the bytes is still stable per file
  const view = new Uint8Array(bytes)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < view.length; i++) {
    h1 = Math.imul(h1 ^ view[i], 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ view[i] ^ (i & 0xff), 0x811c9dc5) >>> 0
  }
  return LOCAL_PREFIX + (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

function chordCount(chords: ChordSegment[]): number {
  return chords.filter((c) => c.label !== 'N').length
}

function currentChords(rec: LocalTrackRecord): ChordSegment[] {
  return rec.edits ?? rec.analysis.chords
}

export function toSummary(rec: LocalTrackRecord): TrackSummary {
  return {
    id: rec.id,
    title: rec.title,
    artist: rec.artist,
    duration: rec.analysis.duration,
    thumbnail: null,
    source: rec.source,
    key: rec.analysis.key,
    tempo: rec.analysis.tempo,
    chordCount: chordCount(currentChords(rec)),
    edited: rec.edits !== null,
    createdAt: rec.createdAt,
  }
}

export function toTrack(rec: LocalTrackRecord, audioUrl: string): Track {
  const a = rec.analysis
  return {
    ...toSummary(rec),
    audioUrl,
    timeSignature: a.timeSignature,
    beats: a.beats,
    downbeats: a.downbeats,
    chords: currentChords(rec),
    waveform: a.waveform,
    engine: a.engine,
  }
}

export function newRecord(
  id: string,
  info: { filename: string; mime: string; size: number; source?: TrackSource },
  analysis: BrowserAnalysis,
  now = new Date().toISOString(),
): LocalTrackRecord {
  return {
    id,
    title: displayName(info.filename),
    artist: null,
    createdAt: now,
    updatedAt: now,
    source: info.source ?? { type: 'file', url: null, videoId: null, filename: info.filename },
    mime: info.mime,
    size: info.size,
    analysis,
    edits: null,
  }
}

// ------------------------------------------------------------------ audio object URL of the open track

/** One object URL at a time: created when a track is opened, revoked when another one replaces it. */
let opened: { id: string; url: Promise<string> } | null = null

function openAudio(id: string): Promise<string> {
  if (opened?.id === id) return opened.url
  const prev = opened
  const url = localRepo()
    .then((repo) => repo.audio(id))
    .then((blob) => (blob ? URL.createObjectURL(blob) : ''))
    .catch(() => '')
  opened = { id, url }
  if (prev) void prev.url.then((u) => u && URL.revokeObjectURL(u))
  return url
}

function closeAudio(id: string): void {
  if (opened?.id !== id) return
  const { url } = opened
  opened = null
  void url.then((u) => u && URL.revokeObjectURL(u))
}

// ------------------------------------------------------------------ repository API

async function mustGet(id: string): Promise<LocalTrackRecord> {
  const rec = await (await localRepo()).get(id)
  if (!rec) throw new LocalError('Track not found', 'not_found', 404)
  return rec
}

export async function listLocalTracks(): Promise<TrackSummary[]> {
  const recs = await (await localRepo()).list()
  return recs.map(toSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function hasLocalTrack(id: string): Promise<boolean> {
  return (await (await localRepo()).get(id)) !== undefined
}

export async function getLocalTrack(id: string): Promise<Track> {
  const rec = await mustGet(id)
  return toTrack(rec, await openAudio(id))
}

export interface LocalTrackPatch {
  title?: string
  artist?: string | null
  chords?: ChordSegment[]
}

/** Same rules as PATCH /api/tracks/{id}: blank titles are ignored, a blank artist clears it. */
export async function patchLocalTrack(id: string, patch: LocalTrackPatch): Promise<Track> {
  const repo = await localRepo()
  const rec = await mustGet(id)
  if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim().slice(0, 300)
  if ('artist' in patch) rec.artist = (patch.artist ?? '').trim().slice(0, 300) || null
  if (Array.isArray(patch.chords)) rec.edits = [...patch.chords].sort((a, b) => a.start - b.start || a.end - b.end)
  rec.updatedAt = new Date().toISOString()
  await repo.put(rec)
  return toTrack(rec, await openAudio(id))
}

/** Drops the user's chord edits (POST /reset). */
export async function resetLocalTrack(id: string): Promise<Track> {
  const repo = await localRepo()
  const rec = await mustGet(id)
  rec.edits = null
  rec.updatedAt = new Date().toISOString()
  await repo.put(rec)
  return toTrack(rec, await openAudio(id))
}

export async function deleteLocalTrack(id: string): Promise<void> {
  const existed = await (await localRepo()).delete(id)
  closeAudio(id)
  if (!existed) throw new LocalError('Track not found', 'not_found', 404)
}

/** Stores a freshly analyzed track with its audio. */
export async function saveNewLocalTrack(rec: LocalTrackRecord, audio: Blob): Promise<void> {
  await (await localRepo()).putWithAudio(rec, audio)
  requestPersistentStorage()
}

/** Replaces the detection of an existing track (re-analysis); like the server, edits are dropped. */
export async function replaceLocalAnalysis(id: string, analysis: BrowserAnalysis): Promise<void> {
  const repo = await localRepo()
  const rec = await mustGet(id)
  rec.analysis = analysis
  rec.edits = null
  rec.updatedAt = new Date().toISOString()
  await repo.put(rec)
}

export async function localAudio(id: string): Promise<Blob> {
  const blob = await (await localRepo()).audio(id)
  if (!blob) throw new LocalError('Audio not found', 'not_found', 404)
  return blob
}

export async function localRecord(id: string): Promise<LocalTrackRecord> {
  return mustGet(id)
}
