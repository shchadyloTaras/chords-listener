// The signed-in user's track data, live-piano notes and vocal notes, read straight from Firebase Storage
// (docs/CLOUD.md "Library in Firestore"): the API publishes users/{uid}/tracks/{id}/track.json next to
// notes.json and vocals.json, readable by their owner only (/storage.rules). The audio and the stems stream
// through download-token URLs built from track.json's `media`. lib/api.ts and lib/vocals.ts read through here
// while the live library (lib/cloud/library) answers, and take the API path on any gap. A file whose read
// failed (rules, CORS, network) is not read again this session: the API answers for it until a reload or
// another account (no retry storms). firebase/storage is loaded on demand (lib/cloud/storage): guests never
// download it.
import type { Track } from '../../types'
import { ApiError } from '../api'
import { firebaseConfig } from '../firebaseConfig'
import { loadStorage } from './storage'

/** Where download-token URLs point. */
export const STORAGE_DOWNLOAD_ORIGIN = 'https://firebasestorage.googleapis.com'

/** A media object of a track: its path in the bucket and its download token. */
export interface MediaRef {
  path: string
  token: string
}

/** track.json's `media`: the audio, and each stem whose object was there when the track was published. */
export interface Media {
  audio: MediaRef
  stems: Record<string, MediaRef>
}

/** track.json: the API's Track JSON without `audioUrl` / `stemUrls`, plus `version` and `media`. */
export type TrackFile = Omit<Track, 'audioUrl' | 'stemUrls'> & { version: number; media: Media }

export type JsonFileName = 'notes.json' | 'vocals.json'
type FileName = 'track.json' | JsonFileName

/** Track ids are one path segment (the server makes them from the content). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The download-token URL of a media object: <audio> plays it and fetch() gets it without any header; it does not expire. */
export function mediaUrl(m: MediaRef): string {
  return `${STORAGE_DOWNLOAD_ORIGIN}/v0/b/${firebaseConfig.storageBucket}/o/${encodeURIComponent(m.path)}?alt=media&token=${encodeURIComponent(m.token)}`
}

/** The Track of a track.json: its audio and stems as token URLs. */
export function trackFromFile(file: TrackFile): Track {
  const { media, ...track } = file
  const stemUrls: Record<string, string> = {}
  for (const [name, ref] of Object.entries(media.stems)) stemUrls[name] = mediaUrl(ref)
  return { ...track, audioUrl: mediaUrl(media.audio), stemUrls }
}

/** Files whose read failed for `failed.uid` this session: the API answers for them from then on. */
let failed: { uid: string; names: Set<FileName> } = { uid: '', names: new Set() }

/** The file parsed; null when there is no such object or it is not JSON. Throws ApiError when it cannot be read. */
async function readFile(uid: string, id: string, name: FileName): Promise<unknown> {
  if (failed.uid !== uid) failed = { uid, names: new Set() }
  if (failed.names.has(name)) throw new ApiError(`${name} could not be read from Storage this session`, 'network')
  if (!ID_RE.test(id)) return null
  let bytes: ArrayBuffer
  try {
    const { storage, sdk } = await loadStorage()
    bytes = await sdk.getBytes(sdk.ref(storage, `users/${uid}/tracks/${id}/${name}`))
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null
    if (code === 'storage/object-not-found') return null
    // the account may have changed meanwhile: then this says nothing about the new one
    if (failed.uid === uid) failed.names.add(name)
    console.warn(`[library] ${name} could not be read from Storage, the API answers for it this session:`, err)
    const denied = code === 'storage/unauthorized' || code === 'storage/unauthenticated'
    throw new ApiError(err instanceof Error ? err.message : String(err), denied ? 'unauthorized' : 'network')
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function isRef(v: unknown): v is MediaRef {
  return !!v && typeof v === 'object' && typeof (v as MediaRef).path === 'string' && typeof (v as MediaRef).token === 'string'
}

/**
 * The track's track.json (version + media). Null when it is not there (not published yet) or not usable (no
 * audio in `media`: its object was missing when the track was published) — the API path then. Throws ApiError
 * ('unauthorized' | 'network') when Storage cannot be read.
 */
export async function readTrackFile(uid: string, id: string): Promise<TrackFile | null> {
  const data = await readFile(uid, id, 'track.json')
  if (!data || typeof data !== 'object') return null
  const file = data as Partial<TrackFile> & { media?: { audio?: unknown; stems?: unknown } }
  if (typeof file.id !== 'string' || typeof file.version !== 'number' || !file.media || !isRef(file.media.audio)) return null
  const stems: Record<string, MediaRef> = {}
  const listed = file.media.stems && typeof file.media.stems === 'object' ? Object.entries(file.media.stems) : []
  for (const [name, ref] of listed) if (isRef(ref)) stems[name] = ref
  return { ...file, media: { audio: file.media.audio, stems } } as TrackFile
}

/** The track's notes.json / vocals.json; null when not computed yet (no object). Throws ApiError like readTrackFile. */
export async function readJsonFile<T>(uid: string, id: string, name: JsonFileName): Promise<T | null> {
  return (await readFile(uid, id, name)) as T | null
}
