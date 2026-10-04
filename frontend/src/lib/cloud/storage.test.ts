import { describe, expect, it } from 'vitest'
import { audioExtension, mediaFilename, newUploadId, safeFilename, storageErrorCode, uploadContentType, uploadPath } from './storage'

describe('uploadPath', () => {
  it('builds users/{uid}/uploads/{uploadId}/{filename}', () => {
    expect(uploadPath('Ab3_x-Y', 'f00dcafe', 'Song.mp3')).toBe('users/Ab3_x-Y/uploads/f00dcafe/Song.mp3')
  })

  it('keeps the file name one safe path segment', () => {
    expect(uploadPath('u1', 'id1', '../../etc/passwd')).toBe('users/u1/uploads/id1/etc_passwd')
    expect(uploadPath('u1', 'id1', 'a/b\\c.wav')).toBe('users/u1/uploads/id1/a_b_c.wav')
    expect(uploadPath('u1', 'id1', 'Пісня #1 [live]?.m4a')).toBe('users/u1/uploads/id1/Пісня _1 _live_.m4a')
  })

  it('rejects uids and upload ids that are not plain segments', () => {
    expect(() => uploadPath('../x', 'id', 'a.mp3')).toThrow()
    expect(() => uploadPath('', 'id', 'a.mp3')).toThrow()
    expect(() => uploadPath('u1', 'a/b', 'a.mp3')).toThrow()
  })
})

describe('safeFilename', () => {
  it('drops control characters, leading dots and keeps the extension when shortening', () => {
    expect(safeFilename('\u0000\u0007.hidden.wav')).toBe('hidden.wav')
    expect(safeFilename('   ')).toBe('audio')
    expect(safeFilename('')).toBe('audio')
    const long = safeFilename(`${'x'.repeat(300)}.flac`)
    expect(long.length).toBe(120)
    expect(long.endsWith('.flac')).toBe(true)
  })
})

describe('uploadContentType', () => {
  it('passes audio/* and video/* without parameters, everything else as octet-stream (Storage rules)', () => {
    expect(uploadContentType('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(uploadContentType('video/mp4')).toBe('video/mp4')
    expect(uploadContentType('AUDIO/MPEG')).toBe('audio/mpeg')
    expect(uploadContentType('')).toBe('application/octet-stream')
    expect(uploadContentType('application/ogg')).toBe('application/octet-stream')
    expect(uploadContentType(undefined)).toBe('application/octet-stream')
  })
})

describe('helpers', () => {
  it('makes unique, path-safe upload ids', () => {
    const a = newUploadId()
    expect(a).toMatch(/^[A-Za-z0-9]{8,32}$/)
    expect(newUploadId()).not.toBe(a)
  })

  it('maps Storage errors', () => {
    expect(storageErrorCode('storage/canceled')).toBe('aborted')
    expect(storageErrorCode('storage/unauthorized')).toBe('denied')
    expect(storageErrorCode('storage/unauthenticated')).toBe('unauthenticated')
    expect(storageErrorCode('storage/retry-limit-exceeded')).toBe('network')
    expect(storageErrorCode('storage/unknown')).toBe('failed')
  })

  it('names recordings after their title', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm')
    expect(audioExtension('audio/mp4')).toBe('m4a')
    expect(audioExtension('audio/wav')).toBe('wav')
    expect(audioExtension('audio/ogg;codecs=opus')).toBe('ogg')
    expect(mediaFilename('Запис 2026-10-04 21-37', 'audio/webm')).toBe('Запис 2026-10-04 21-37.webm')
    expect(mediaFilename('a/b: c?', 'audio/wav')).toBe('a b c.wav')
    expect(mediaFilename('  ', 'audio/mpeg')).toBe('recording.mp3')
  })
})
