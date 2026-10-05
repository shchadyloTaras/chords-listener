import { describe, expect, it } from 'vitest'
import { INSTRUMENTS, isFretted, isKeyboard, keyInstrument } from './instruments'

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
