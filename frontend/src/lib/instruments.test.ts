import { describe, expect, it } from 'vitest'
import { hasCapo, INSTRUMENTS, isFretted, isKeyboard, isWind, liveKeysInstrument, nextInstrument } from './instruments'

describe('instruments', () => {
  it('lists all eight in the picker order', () => {
    expect(INSTRUMENTS).toEqual(['guitar', 'bass', 'ukulele', 'piano', 'harmonium', 'handpan', 'sopilka', 'flute'])
  })

  it('groups keyboards, fretted and wind instruments', () => {
    expect(INSTRUMENTS.filter(isKeyboard)).toEqual(['piano', 'harmonium'])
    expect(INSTRUMENTS.filter(isFretted)).toEqual(['guitar', 'bass', 'ukulele'])
    expect(INSTRUMENTS.filter(isWind)).toEqual(['sopilka', 'flute'])
  })
})

describe('instrument behaviour', () => {
  it('suggests a capo only for the guitar and the ukulele', () => {
    expect(INSTRUMENTS.filter(hasCapo)).toEqual(['guitar', 'ukulele'])
  })

  it('cycles through all eight with the I key, back to the guitar', () => {
    const seen = ['guitar'] as ReturnType<typeof nextInstrument>[]
    for (let i = 0; i < 8; i++) seen.push(nextInstrument(seen[seen.length - 1]))
    expect(seen).toEqual(['guitar', 'bass', 'ukulele', 'piano', 'harmonium', 'handpan', 'sopilka', 'flute', 'guitar'])
  })

  it('keeps a keyboard when the live keys are turned on, else picks the piano', () => {
    expect(liveKeysInstrument('harmonium')).toBe('harmonium')
    expect(liveKeysInstrument('piano')).toBe('piano')
    expect(liveKeysInstrument('bass')).toBe('piano')
    expect(liveKeysInstrument('flute')).toBe('piano')
  })
})
