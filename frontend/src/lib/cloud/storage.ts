// Uploads for the cloud API (docs/CLOUD.md "Uploads"): Cloud Run caps request bodies at 32 MiB, so the
// browser sends the file straight to Firebase Storage (resumable, with progress) under
// users/{uid}/uploads/{uploadId}/{filename}; POST /api/jobs/storage then ingests it.
// firebase/storage is loaded on demand: guests never download it.
import type { FirebaseStorage, StorageError } from 'firebase/storage'

/** `firebase emulators:start --only auth,storage` (see /firebase.json). */
export const STORAGE_EMULATOR_PORT = 9199
/** Storage rules accept at most 500 MB per upload. */
export const MAX_STORAGE_UPLOAD_BYTES = 500 * 1024 * 1024

export type StorageUploadErrorCode = 'aborted' | 'denied' | 'unauthenticated' | 'network' | 'too_large' | 'failed'

export class StorageUploadError extends Error {
  readonly code: StorageUploadErrorCode
  constructor(code: StorageUploadErrorCode, message: string = code) {
    super(message)
    this.name = 'StorageUploadError'
    this.code = code
  }
}

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 120

/**
 * The file name as one safe path segment: no slashes, control or wildcard characters, no leading
 * dots, at most 120 characters (the extension survives shortening).
 */
export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  let base = (name || '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\#[\]*?]+/g, '_')
  base = base.replace(/^[.\s_]+/, '').replace(/\s+/g, ' ').trim()
  if (!base) base = 'audio'
  if (base.length > MAX_NAME) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0] ?? ''
    base = base.slice(0, MAX_NAME - ext.length).trimEnd() + ext
  }
  return base
}

/** File extension for an audio MIME type ("audio/webm;codecs=opus" → "webm"). */
export function audioExtension(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('wav')) return 'wav'
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a'
  if (m.includes('ogg') || m.includes('opus')) return m.includes('webm') ? 'webm' : 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('flac')) return 'flac'
  return 'webm'
}

/** "<title>.<ext>" for a recording / stored audio: keeps letters of any script, drops characters file systems dislike. */
export function mediaFilename(title: string, mime: string): string {
  // eslint-disable-next-line no-control-regex
  const base = title.replace(/[\\/:*?"<>|#\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'recording'
  return `${base}.${audioExtension(mime)}`
}

/** Object path of an upload: `users/{uid}/uploads/{uploadId}/{filename}` (the server checks the prefix). */
export function uploadPath(uid: string, uploadId: string, filename: string): string {
  if (!UID_RE.test(uid)) throw new Error('invalid uid')
  if (!UPLOAD_ID_RE.test(uploadId)) throw new Error('invalid upload id')
  return `users/${uid}/uploads/${uploadId}/${safeFilename(filename)}`
}

/** Content type the Storage rules accept: audio/*, video/* (without parameters) or application/octet-stream. */
export function uploadContentType(type: string | null | undefined): string {
  const bare = (type ?? '').split(';')[0].trim().toLowerCase()
  return /^(audio|video)\/[\w.+-]+$/.test(bare) ? bare : 'application/octet-stream'
}

export function newUploadId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return (uuid ?? `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`).replace(/-/g, '').slice(0, 32)
}

/** Maps Firebase Storage error codes to ours. */
export function storageErrorCode(code: string | undefined): StorageUploadErrorCode {
  switch (code) {
    case 'storage/canceled':
      return 'aborted'
    case 'storage/unauthorized':
      return 'denied'
    case 'storage/unauthenticated':
      return 'unauthenticated'
    case 'storage/retry-limit-exceeded':
      return 'network'
    default:
      return 'failed'
  }
}

type StorageSdk = typeof import('firebase/storage')

let loading: Promise<{ storage: FirebaseStorage; sdk: StorageSdk }> | null = null

/** Firebase app + Storage chunks, once (the emulator in `VITE_FIREBASE_EMULATORS=true` builds). */
function loadStorage() {
  loading ??= Promise.all([import('../firebase'), import('firebase/storage')]).then(
    ([fb, sdk]) => {
      const storage = sdk.getStorage(fb.app)
      if (fb.useEmulators) sdk.connectStorageEmulator(storage, fb.EMULATOR_HOST, STORAGE_EMULATOR_PORT)
      return { storage, sdk }
    },
    (err: unknown) => {
      loading = null
      throw new StorageUploadError('network', `Firebase Storage is unavailable: ${String(err)}`)
    },
  )
  return loading
}

export interface StorageUploadOptions {
  uid: string
  /** defaults to the File's name */
  filename?: string
  signal?: AbortSignal
  onProgress?(loaded: number, total: number): void
}

/** Uploads `file` (resumable, retried by the SDK) and resolves with its object path. */
export async function uploadToStorage(file: Blob, opts: StorageUploadOptions): Promise<string> {
  const { uid, signal, onProgress } = opts
  if (signal?.aborted) throw new StorageUploadError('aborted')
  if (file.size > MAX_STORAGE_UPLOAD_BYTES) throw new StorageUploadError('too_large')
  const filename = opts.filename || (file instanceof File ? file.name : '') || 'audio'
  const path = uploadPath(uid, newUploadId(), filename)
  const { storage, sdk } = await loadStorage()
  if (signal?.aborted) throw new StorageUploadError('aborted')
  const task = sdk.uploadBytesResumable(sdk.ref(storage, path), file, {
    contentType: uploadContentType(file.type),
    customMetadata: { originalName: filename.slice(0, 300) },
  })
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => task.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbort)
    task.on(
      'state_changed',
      (snap) => onProgress?.(snap.bytesTransferred, snap.totalBytes || file.size),
      (err: StorageError) => {
        done()
        reject(new StorageUploadError(storageErrorCode(err.code), err.message))
      },
      () => {
        done()
        onProgress?.(file.size, file.size)
        resolve(path)
      },
    )
  })
}
