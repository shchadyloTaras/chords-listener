// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { useChordUi } from '../../components/chords/uiStore'
import type { NoteEvent } from './chordNotes'
import { harmoniumChordNotes } from './chordNotes'
import { chordSoundNotes } from './play'

const midis = (notes: NoteEvent[] | Promise<NoteEvent[]>) => (notes as NoteEvent[]).map((n) => n.midi)

beforeEach(() => useChordUi.setState({ voicings: {} }))

it('plays the bass shape the diagram shows, right away (nothing to load)', () => {
  const notes = chordSoundNotes('Am', 'bass')
  expect(Array.isArray(notes)).toBe(true)
  expect(midis(notes)).toEqual([33, 36, 40, 45])
  // the diagram's ‹ › choice, wrapped like the diagram wraps it (Am has 3 shapes)
  useChordUi.getState().setVoicing('bass:Am', 1)
  expect(midis(chordSoundNotes('Am', 'bass'))).toEqual([33, 40, 48])
  useChordUi.getState().setVoicing('bass:Am', 4)
  expect(midis(chordSoundNotes('Am', 'bass'))).toEqual([33, 40, 48])
})

it('still sounds a chord the bass cannot fully hold', () => {
  expect(midis(chordSoundNotes('Cmaj7/D', 'bass')).length).toBeGreaterThan(0)
})

it('plays the harmonium from its diagram', () => {
  expect(chordSoundNotes('C', 'harmonium')).toEqual(harmoniumChordNotes('C'))
  expect(chordSoundNotes('N', 'harmonium')).toEqual([])
})
