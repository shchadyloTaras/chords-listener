// Derived chord model for the loaded track, computed once and shared via context.

import { createContext, useContext, useMemo } from 'react'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { buildBarGrid, fillBars, type Bar } from '../../lib/music/bars'
import { hasCapo } from '../../lib/instruments'
import { suggestCapo, type CapoSuggestion } from '../../lib/music/capo'
import { buildDisplayChords, uniqueChords, type DisplayChord, type UniqueChord } from '../../lib/music/display'
import type { ExportInput } from '../../lib/music/formats'
import { resolveSpelling, transposeKeyName } from '../../lib/music/key'
import type { Spelling } from '../../lib/music/notes'
import { detectSections, withKinds, type SongSection } from '../../lib/music/sections'
import type { EffectiveRhythm } from '../../lib/tempo'
import { useEffectiveRhythm } from './tempo/useRhythm'

export interface ChordModel {
  track: Track
  transpose: number
  simplify: boolean
  spelling: Spelling
  /** key after transposition (display spelling) */
  keyName: string | null
  /** key as detected (display spelling) */
  originalKeyName: string | null
  chords: DisplayChord[]
  bars: Bar[]
  unique: UniqueChord[]
  capo: CapoSuggestion | null
  /** true when there is at least one real chord */
  hasChords: boolean
  /** beats / downbeats / tempo after the per-track tempo correction; `bars` are built from it */
  rhythm: EffectiveRhythm
  /** the song's parts (intro, verse, chorus, …) over the bars, with the user's names for them */
  sections: SongSection[]
  exportInput(barsPerLine: number, collapseRepeats: boolean): ExportInput
}

/** Provided by <ChordWorkspace> (`<ChordModelContext value={model}>`). */
export const ChordModelContext = createContext<ChordModel | null>(null)

export function useBuildChordModel(track: Track): ChordModel {
  const transpose = useApp((s) => s.transpose)
  const simplify = useApp((s) => s.simplify)
  const accidentals = useApp((s) => s.accidentals)
  const instrument = useApp((s) => s.instrument)

  const spelling = resolveSpelling(accidentals, track.key, transpose)
  const chords = useMemo(
    () => buildDisplayChords(track.chords, { transpose, simplify, spelling }),
    [track.chords, transpose, simplify, spelling],
  )
  const rhythm = useEffectiveRhythm(track)
  const frames = useMemo(
    () =>
      buildBarGrid({
        duration: track.duration,
        beats: rhythm.beats,
        downbeats: rhythm.downbeats,
        tempo: rhythm.tempo,
        timeSignature: rhythm.timeSignature,
      }),
    [track.duration, rhythm],
  )
  const bars = useMemo(() => fillBars(frames, chords), [frames, chords])
  const unique = useMemo(() => uniqueChords(chords), [chords])
  // song parts: from the chords as detected (transposing / simplifying / spelling cannot change them),
  // on the same bar grid as the sheet
  const plainBars = useMemo(() => fillBars(frames, buildDisplayChords(track.chords, { transpose: 0, simplify: false, spelling: 'sharp' })), [frames, track.chords])
  const detected = useMemo(
    () => detectSections({ bars: plainBars, waveform: track.waveform, duration: track.duration }),
    [plainBars, track.waveform, track.duration],
  )
  const kinds = useApp((s) => s.sectionKinds?.[track.id])
  const sections = useMemo(() => withKinds(detected, kinds), [detected, kinds])
  const capo = useMemo(
    () =>
      hasCapo(instrument)
        ? suggestCapo(
            unique.map((u) => ({ label: u.label, weight: u.count })),
            instrument,
          )
        : null,
    [unique, instrument],
  )

  return useMemo<ChordModel>(() => {
    const keyName = transposeKeyName(track.key, transpose, spelling)
    const originalKeyName = transposeKeyName(track.key, 0, resolveSpelling(accidentals, track.key, 0))
    return {
      track,
      transpose,
      simplify,
      spelling,
      keyName,
      originalKeyName,
      chords,
      bars,
      unique,
      capo,
      hasChords: unique.length > 0,
      rhythm,
      sections,
      exportInput: (barsPerLine, collapseRepeats) => ({
        meta: {
          title: track.title,
          artist: track.artist,
          keyName,
          tempo: rhythm.tempo,
          timeSignature: track.timeSignature,
        },
        chords,
        bars,
        barsPerLine,
        collapseRepeats,
      }),
    }
  }, [track, transpose, simplify, spelling, accidentals, chords, bars, unique, capo, rhythm, sections])
}

export function useChordModel(): ChordModel {
  const m = useContext(ChordModelContext)
  if (!m) throw new Error('useChordModel must be used inside <ChordWorkspace>')
  return m
}
