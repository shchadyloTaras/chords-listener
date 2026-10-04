// Live-piano notes of browser tracks (mirrors GET / PUT /api/tracks/{id}/notes): stored in IndexedDB
// next to the track, removed together with it, kept when the chords are analyzed again.
import type { TrackNotes } from '../../types'
import { localRepo } from './db'
import { LocalError } from './errors'

/** The track's saved notes; null when they were not computed yet. */
export async function getLocalNotes(id: string): Promise<TrackNotes | null> {
  const repo = await localRepo()
  if (!(await repo.get(id))) throw new LocalError('Track not found', 'not_found', 404)
  return (await repo.getNotes(id)) ?? null
}

/** Saves (replaces) the track's notes. */
export async function putLocalNotes(id: string, notes: TrackNotes): Promise<void> {
  const repo = await localRepo()
  if (!(await repo.get(id))) throw new LocalError('Track not found', 'not_found', 404)
  await repo.putNotes(id, notes)
}
