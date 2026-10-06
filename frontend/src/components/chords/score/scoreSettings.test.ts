// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { migrateScoreSettings, scoreOptions, useScoreSettings } from './scoreSettings'

describe('score settings', () => {
  it('start with the full notation', () => {
    expect(scoreOptions(useScoreSettings.getState())).toEqual({ vocals: true, piano: true, chords: true, level: 'full' })
  })

  it('v1 → v2: «Спрощено» becomes the medium level, otherwise full', () => {
    expect(migrateScoreSettings({ vocals: false, piano: true, chords: true, simplified: true, liveVocals: false }, 1)).toEqual({
      vocals: false,
      piano: true,
      chords: true,
      level: 'medium',
      liveVocals: false,
    })
    expect(migrateScoreSettings({ vocals: true, piano: false, chords: false, simplified: false, liveVocals: true }, 1)).toEqual({
      vocals: true,
      piano: false,
      chords: false,
      level: 'full',
      liveVocals: true,
    })
    expect(migrateScoreSettings({}, 1)).toEqual({ level: 'full' })
    expect(migrateScoreSettings(null, 1)).toEqual({ level: 'full' })
  })

  it('reads a state stored by v1 and stores it as v2', async () => {
    const key = 'chords-listener-score'
    localStorage.setItem(key, JSON.stringify({ state: { vocals: true, piano: false, chords: true, simplified: true, liveVocals: true }, version: 1 }))
    await useScoreSettings.persist.rehydrate()
    const s = useScoreSettings.getState()
    expect(scoreOptions(s)).toEqual({ vocals: true, piano: false, chords: true, level: 'medium' })
    expect('simplified' in s).toBe(false)
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
    expect(stored.version).toBe(2)
    expect(stored.state).toEqual({ vocals: true, piano: false, chords: true, level: 'medium', liveVocals: true })
  })
})
