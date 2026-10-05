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
