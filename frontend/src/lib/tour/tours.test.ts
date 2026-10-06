// The six tours as data: step counts per screen and breakpoint, 43 distinct anchors, conditions, text keys.
import { describe, expect, it } from 'vitest'
import { conditionHolds, textKey, textKeys, titleKey, tourAnchors, TOUR_IDS, TOURS, type TourFlags } from './tours'

/** steps whose conditions hold for these flags, anchors ignored */
const shown = (id: (typeof TOUR_IDS)[number], flags: TourFlags) =>
  TOURS[id].steps.filter((s) => (s.when ?? []).every((c) => conditionHolds(c, flags))).map((s) => s.id)

describe('tour definitions', () => {
  it('has the six tours in a fixed order', () => {
    expect(TOUR_IDS).toEqual(['home', 'song', 'score', 'keys', 'listen', 'capture'])
    for (const id of TOUR_IDS) expect(TOURS[id].id).toBe(id)
  })

  it('anchors 43 distinct ids', () => {
    expect(tourAnchors()).toHaveLength(43)
  })

  it('keeps step ids unique inside each tour', () => {
    for (const id of TOUR_IDS) {
      const ids = TOURS[id].steps.map((s) => s.id)
      expect(new Set(ids).size, id).toBe(ids.length)
    }
  })

  it('Home: 8 steps; step 8 is the settings group on a desktop and ⋯ on a phone', () => {
    const all = { libraryEmpty: true, libraryList: true, cloudInvite: true }
    expect(shown('home', all)).toHaveLength(8)
    expect(shown('home', all)).toContain('settings')
    expect(shown('home', { ...all, phone: true })).toHaveLength(8)
    expect(shown('home', { ...all, phone: true })).toContain('more')
  })

  it('Song: 12 steps on a desktop, 13 on a phone (step 4 split in two)', () => {
    const all = { sheetView: true, hasChords: true }
    expect(shown('song', all)).toHaveLength(12)
    expect(shown('song', { ...all, phone: true })).toHaveLength(13)
    expect(shown('song', { ...all, phone: true })).toEqual(expect.arrayContaining(['keyTranspose', 'keyShape']))
  })

  it('Score 5, Live keys 4 either way, Listen 6, YouTube 4 with a tab and 2 without', () => {
    expect(shown('score', { scoreRendered: true })).toHaveLength(5)
    expect(shown('keys', { keysReady: true })).toEqual(['canvas', 'edges', 'sync', 'voice'])
    expect(shown('keys', {})).toEqual(['intro', 'sync', 'voice'])
    expect(shown('listen', {})).toHaveLength(6)
    expect(shown('capture', { canListenInTab: true })).toEqual(['video', 'start', 'howto', 'controls'])
    expect(shown('capture', {})).toEqual(['videoNoTab', 'alt'])
  })

  it('conditions: a flag, its negation, and a missing flag as false', () => {
    expect(conditionHolds('phone', { phone: true })).toBe(true)
    expect(conditionHolds('phone', {})).toBe(false)
    expect(conditionHolds('!phone', {})).toBe(true)
    expect(conditionHolds('!phone', { phone: true })).toBe(false)
  })

  it('text keys: the base plus the variants that hold, in the declared order', () => {
    const player = TOURS.song.steps.find((s) => s.id === 'player')!
    expect(titleKey('song', player)).toBe('tour.song.player.title')
    expect(textKey('song', player, {})).toBe('tour.song.player.text')
    expect(textKey('song', player, { touch: true })).toBe('tour.song.player.text.touch')
    expect(textKey('song', player, { demo: true, touch: true })).toBe('tour.song.player.text.demo.touch')
    expect(textKeys('song', player)).toEqual([
      'tour.song.player.text',
      'tour.song.player.text.demo',
      'tour.song.player.text.touch',
      'tour.song.player.text.demo.touch',
    ])
    const sources = TOURS.listen.steps.find((s) => s.id === 'sources')!
    expect(textKey('listen', sources, { canListenInTab: true })).toBe('tour.listen.sources.text')
    expect(textKey('listen', sources, {})).toBe('tour.listen.sources.text.noTab')
  })

  it('Song steps 1–4 scroll to the top first; step 7 is a centred card with the chord-marks body', () => {
    const top = TOURS.song.steps.filter((s) => s.scrollTop).map((s) => s.id)
    expect(top).toEqual(['now', 'instrument', 'tempo', 'keyAll', 'keyTranspose', 'keyShape'])
    const marks = TOURS.song.steps.find((s) => s.id === 'marks')!
    expect(marks).toMatchObject({ anchors: [], centre: true, body: 'chordMarks' })
  })
})
