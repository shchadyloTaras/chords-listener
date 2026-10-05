import { describe, expect, it } from 'vitest'
import { stepsFor } from './stages'

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
