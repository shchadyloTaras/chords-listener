import { describe, expect, it } from 'vitest'
import { parseHash, paths } from './useRoute'

describe('listen route title', () => {
  it('round-trips a title', () => {
    const p = paths.listen('mic', { title: 'Анна — Пісня & co' })
    expect(parseHash(`#${p}`)).toEqual({ name: 'listen', source: 'mic', title: 'Анна — Пісня & co' })
  })
  it('no title', () => {
    expect(parseHash('#/listen?src=mic')).toEqual({ name: 'listen', source: 'mic', title: null })
  })
})

describe('YouTube routes', () => {
  const ID = 'dQw4w9WgXcQ'

  it('the fragment picker, with the start when given', () => {
    expect(paths.clip(ID)).toBe(`/youtube/${ID}`)
    expect(paths.clip(ID, { t: 72.9 })).toBe(`/youtube/${ID}?t=72`)
    expect(parseHash(`#/youtube/${ID}`)).toEqual({ name: 'clip', videoId: ID, start: null })
    expect(parseHash(`#${paths.clip(ID, { t: 72 })}`)).toEqual({ name: 'clip', videoId: ID, start: 72 })
    expect(parseHash(`#/youtube/${ID}?t=abc`)).toEqual({ name: 'clip', videoId: ID, start: null })
    expect(parseHash('#/youtube/not-an-id')).toEqual({ name: 'notFound' })
  })

  it('the capture page keeps ?blocked=1 and takes a start', () => {
    expect(paths.capture(ID, { blocked: true })).toBe(`/listen/youtube/${ID}?blocked=1`)
    expect(paths.capture(ID, { blocked: true, t: 72 })).toBe(`/listen/youtube/${ID}?blocked=1&t=72`)
    expect(paths.capture(ID, { t: 0 })).toBe(`/listen/youtube/${ID}`)
    expect(parseHash(`#/listen/youtube/${ID}?blocked=1&t=72`)).toEqual({ name: 'capture', videoId: ID, blocked: true, start: 72 })
    expect(parseHash(`#/listen/youtube/${ID}`)).toEqual({ name: 'capture', videoId: ID, blocked: false, start: null })
  })
})
