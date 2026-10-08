import { describe, expect, it } from 'vitest'
import type { Settings } from '../store'
import { isValidSynced, parseSynced, pickSynced, SYNCED_DEFAULTS, SYNCED_KEYS, syncedChanged, syncedKey } from './syncedSettings'

/** Local settings with every device-only field set to a non-default value. */
const local = {
  ...SYNCED_DEFAULTS,
  theme: 'light',
  instrument: 'piano',
  barsPerLine: 8,
  transpose: 3,
  volume: 0.4,
  muted: true,
  playbackRate: 1.25,
  handpanScale: 'custom',
  handpanNotes: ['A', 'D', 'F', 'A', 'C', 'G', 'E', 'C', 'A'],
  metronome: true,
  metronomeVolume: 0.6,
  tempoFactors: { abc: 2 },
  serverUrl: 'http://localhost:8765',
  chordSound: false,
  chordSoundVolume: 0.3,
  liveKeys: false,
  syncOffsetMs: 40,
  liveKeysSource: 'song',
  keepAwake: false,
  harmoniumDrone: true,
  playAlong: true,
  playAlongVolume: 1.5,
  playAlongOffsetMs: -20,
} as Settings

describe('pickSynced', () => {
  it('takes exactly the 11 synced keys', () => {
    const picked = pickSynced(local)
    expect(SYNCED_KEYS).toHaveLength(11)
    expect(Object.keys(picked).sort()).toEqual([...SYNCED_KEYS].sort())
    expect(picked).toMatchObject({ theme: 'light', instrument: 'piano', barsPerLine: 8 })
    for (const k of ['transpose', 'volume', 'handpanNotes', 'metronome', 'tempoFactors', 'serverUrl', 'chordSound', 'liveKeys', 'syncOffsetMs', 'liveKeysSource', 'keepAwake', 'harmoniumDrone', 'playAlong', 'playAlongVolume', 'playAlongOffsetMs']) {
      expect(picked).not.toHaveProperty(k)
    }
  })

  it('keeps the handpan instrument', () => {
    expect(pickSynced({ ...local, instrument: 'handpan' }).instrument).toBe('handpan')
  })

  it('keeps the bass and the harmonium', () => {
    expect(pickSynced({ ...local, instrument: 'bass' }).instrument).toBe('bass')
    expect(pickSynced({ ...local, instrument: 'harmonium' }).instrument).toBe('harmonium')
    expect(isValidSynced('instrument', 'harmonium')).toBe(true)
    expect(isValidSynced('instrument', 'banjo')).toBe(false)
  })

  it('never emits a value the rules would reject', () => {
    const odd = { ...local, instrument: 'banjo', barsPerLine: 3 } as unknown as Settings
    // falls back to the last synced value…
    expect(pickSynced(odd, { instrument: 'ukulele', barsPerLine: 2 })).toMatchObject({ instrument: 'ukulele', barsPerLine: 2 })
    // …or to the default
    expect(pickSynced(odd)).toMatchObject({ instrument: 'guitar', barsPerLine: 4 })
  })
})

describe('syncedChanged', () => {
  it('reacts only to synced keys', () => {
    expect(syncedChanged(local, { ...local })).toBe(false)
    expect(syncedChanged(local, { ...local, volume: 1, transpose: -2, handpanNotes: ['D'], metronome: false })).toBe(false)
    expect(syncedChanged(local, { ...local, theme: 'dark' })).toBe(true)
    expect(syncedChanged(local, { ...local, instrument: 'handpan' })).toBe(true)
    expect(syncedChanged(local, { ...local, showVideo: true })).toBe(true)
  })
})

describe('parseSynced', () => {
  it('accepts a well-formed settings map, including handpan', () => {
    const remote = { ...SYNCED_DEFAULTS, instrument: 'handpan', theme: 'system', barsPerLine: 2 }
    expect(parseSynced(remote)).toEqual(remote)
  })

  it('drops invalid values and unknown keys', () => {
    const parsed = parseSynced({
      ...SYNCED_DEFAULTS,
      barsPerLine: 3,
      theme: 'blue',
      simplify: 'true',
      follow: 1,
      instrument: 'banjo',
      volume: 0.2,
    })
    for (const k of ['barsPerLine', 'theme', 'simplify', 'follow', 'instrument', 'volume']) {
      expect(parsed).not.toHaveProperty(k)
    }
    expect(parsed).toMatchObject({ accidentals: 'auto', lang: 'uk', showVideo: false })
  })

  it('accepts the score view and rejects unknown views', () => {
    expect(parseSynced({ ...SYNCED_DEFAULTS, view: 'score' })).toMatchObject({ view: 'score' })
    expect(parseSynced({ view: 'tabs' })).toEqual({})
  })

  it('rejects a numeric string for barsPerLine', () => {
    expect(parseSynced({ barsPerLine: '4' })).toEqual({})
  })

  it('ignores anything that is not a map', () => {
    expect(parseSynced(undefined)).toEqual({})
    expect(parseSynced(null)).toEqual({})
    expect(parseSynced('dark')).toEqual({})
  })
})

describe('syncedKey', () => {
  it('does not depend on key order', () => {
    const reversed = Object.fromEntries(Object.entries(SYNCED_DEFAULTS).reverse())
    expect(syncedKey(reversed)).toBe(syncedKey(SYNCED_DEFAULTS))
    expect(syncedKey({ ...SYNCED_DEFAULTS, lang: 'en' })).not.toBe(syncedKey(SYNCED_DEFAULTS))
  })
})
