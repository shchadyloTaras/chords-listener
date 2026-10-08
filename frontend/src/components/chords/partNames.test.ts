// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from '../../store'
import { partName, partTime, setPartKind } from './partNames'

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key)

describe('song part names', () => {
  beforeEach(() => useApp.getState().setSetting('sectionKinds', {}))

  it('names a part, numbering repeats and spelling A′ with a typographic apostrophe', () => {
    expect(partName(t, 'chorus', 'B')).toBe('chords.section.chorus')
    expect(partName(t, 'verse', 'A', 2, 3)).toBe('chords.section.verse 2')
    expect(partName(t, 'verse', 'A', 1, 1)).toBe('chords.section.verse')
    expect(partName(t, 'part', 'A′')).toBe('chords.section.part(A’)')
    expect(partTime(0)).toBe('0:00')
    expect(partTime(125.7)).toBe('2:05')
  })

  it('renames a part per track and gives back the detected name, dropping empty tracks', () => {
    setPartKind('t1', '12', 'chorus')
    setPartKind('t1', '40', 'bridge')
    setPartKind('t2', '0', 'intro')
    expect(useApp.getState().sectionKinds).toEqual({ t1: { 12: 'chorus', 40: 'bridge' }, t2: { 0: 'intro' } })
    setPartKind('t1', '12', null)
    setPartKind('t2', '0', null)
    expect(useApp.getState().sectionKinds).toEqual({ t1: { 40: 'bridge' } })
  })
})
