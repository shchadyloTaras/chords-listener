import { describe, expect, it } from 'vitest'
import { customScale, DEFAULT_HANDPAN_NOTES, playability } from '../../../lib/handpan'
import { describePlay, pluralForm } from './text'

describe('handpan text', () => {
  it('picks Ukrainian and English plural forms', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map((n) => pluralForm('uk', n))).toEqual([
      'one',
      'few',
      'few',
      'many',
      'many',
      'many',
      'one',
      'few',
      'many',
    ])
    expect([1, 2, 5].map((n) => pluralForm('en', n))).toEqual(['one', 'many', 'many'])
  })

  it('describes where to play a chord', () => {
    const scale = customScale(DEFAULT_HANDPAN_NOTES)
    expect(describePlay('uk', 'Am', playability('Am', scale)!, scale, 'sharp')).toBe(
      'Am на хендпані. Грай: A — дінг і 2 поля, C — 2 поля, E — 1 поле.',
    )
    expect(describePlay('en', 'E', playability('E', scale)!, scale, 'sharp')).toBe(
      'E on the handpan. Play: E — 1 field. Missing: G#, B.',
    )
  })
})
