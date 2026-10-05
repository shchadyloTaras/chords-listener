import { describe, expect, it } from 'vitest'
import { hasCapo, INSTRUMENTS, isFretted, isKeyboard, keyInstrument, liveKeysInstrument, nextInstrument } from './instruments'

describe('instruments', () => {
  it('lists all six in the picker order', () => {
    expect(INSTRUMENTS).toEqual(['guitar', 'bass', 'ukulele', 'piano', 'harmonium', 'handpan'])
  })

  it('groups keyboards and fretted instruments', () => {
    expect(INSTRUMENTS.filter(isKeyboard)).toEqual(['piano', 'harmonium'])
    expect(INSTRUMENTS.filter(isFretted)).toEqual(['guitar', 'bass', 'ukulele'])
  })

  it('plays diagram keys on the harmonium only when it is the instrument', () => {
    expect(keyInstrument('harmonium')).toBe('harmonium')
    expect(keyInstrument('piano')).toBe('piano')
    expect(keyInstrument('guitar')).toBe('piano')
    expect(keyInstrument(undefined)).toBe('piano')
  })
})

describe('instrument behaviour', () => {
  it('suggests a capo only for the guitar and the ukulele', () => {
    expect(INSTRUMENTS.filter(hasCapo)).toEqual(['guitar', 'ukulele'])
  })

  it('cycles through all six with the I key, back to the guitar', () => {
    const seen = ['guitar'] as ReturnType<typeof nextInstrument>[]
    for (let i = 0; i < 6; i++) seen.push(nextInstrument(seen[seen.length - 1]))
    expect(seen).toEqual(['guitar', 'bass', 'ukulele', 'piano', 'harmonium', 'handpan', 'guitar'])
  })

  it('keeps a keyboard when the live keys are turned on, else picks the piano', () => {
    expect(liveKeysInstrument('harmonium')).toBe('harmonium')
    expect(liveKeysInstrument('piano')).toBe('piano')
    expect(liveKeysInstrument('bass')).toBe('piano')
  })
})
