import { describe, expect, it } from 'vitest'
import { stepIndex, stepsFor } from './stages'

describe('stepsFor', () => {
  it('uploads and recordings have no download step', () => {
    expect(stepsFor({ source: { type: 'file', filename: 'a.mp3' } })).toEqual(['decode', 'analyze'])
  })
  it('links are downloaded first', () => {
    expect(stepsFor({ source: { type: 'youtube', videoId: 'x', url: null, filename: null } })).toEqual(['download', 'decode', 'analyze'])
    expect(stepsFor({ source: { type: 'url', url: 'https://example.com/a' } })).toEqual(['download', 'decode', 'analyze'])
  })
  it('a job whose source is not known yet keeps all three', () => {
    expect(stepsFor({ source: undefined })).toEqual(['download', 'decode', 'analyze'])
  })
})

describe('stepIndex', () => {
  it('follows the status', () => {
    expect(stepIndex('downloading')).toBe(0)
    expect(stepIndex('decoding')).toBe(1)
    expect(stepIndex('analyzing')).toBe(2)
    expect(stepIndex('done')).toBe(3)
    expect(stepIndex('error')).toBe(-1)
  })
  it('a job waiting in the queue has not started: the first stage', () => {
    expect(stepIndex('queued')).toBe(0)
    expect(stepIndex('queued', 0)).toBe(0)
  })
  it('a fragment waiting for analysis after its download (queued at 0.35) has finished the download stage', () => {
    expect(stepIndex('queued', 0.35)).toBe(1)
    expect(stepIndex('queued', 0.349)).toBe(0)
    expect(stepIndex('downloading', 0.35)).toBe(0)
  })
})
