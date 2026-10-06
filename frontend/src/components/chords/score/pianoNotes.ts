// The instruments' notes for the live piano and the score: transcribed in the page from the
// instruments stem when the server separated one (no singer in the piano part), else from the mix.

import { useCallback } from 'react'
import { notesKey, useNotesStore, useTrackNotes, type NotesSource, type NotesState } from '../../../lib/transcription'
import { fetchStem, useStems } from '../../../lib/vocals'
import { useApp } from '../../../store'
import type { Track } from '../../../types'

/**
 * `start: false` never starts a transcription, but keeps one that is already running for the track
 * alive (the score's simple level: switching to it must not throw away minutes of work, and the
 * finished notes stay in memory for the other levels).
 */
export function usePianoNotes(track: Track | null, opts: { start?: boolean } = {}): { notes: NotesState; source: NotesSource } {
  const stems = useStems(track)
  const source: NotesSource = stems.includes('instruments') ? 'instruments' : 'mix'
  const id = track?.id ?? ''
  const key = id ? notesKey(id, source) : ''
  const running = useNotesStore((s) => {
    const status = key ? s.tracks[key]?.status : undefined
    return status === 'loading' || status === 'computing'
  })
  const loadAudio = useCallback(
    (signal: AbortSignal) => {
      const t = useApp.getState().track
      return fetchStem(t && t.id === id ? t : { id }, 'instruments', signal)
    },
    [id],
  )
  const notes = useTrackNotes(opts.start === false && !running ? null : track, source === 'instruments' ? { source, loadAudio } : {})
  return { notes, source }
}
