// The instruments' notes for the live piano and the score: transcribed in the page from the
// instruments stem when the server separated one (no singer in the piano part), else from the mix.

import { useCallback } from 'react'
import { useTrackNotes, type NotesSource, type NotesState } from '../../../lib/transcription'
import { fetchStem, useStems } from '../../../lib/vocals'
import { useApp } from '../../../store'
import type { Track } from '../../../types'

export function usePianoNotes(track: Track | null): { notes: NotesState; source: NotesSource } {
  const stems = useStems(track)
  const source: NotesSource = stems.includes('instruments') ? 'instruments' : 'mix'
  const id = track?.id ?? ''
  const loadAudio = useCallback(
    (signal: AbortSignal) => {
      const t = useApp.getState().track
      return fetchStem(t && t.id === id ? t : { id }, 'instruments', signal)
    },
    [id],
  )
  const notes = useTrackNotes(track, source === 'instruments' ? { source, loadAudio } : {})
  return { notes, source }
}
