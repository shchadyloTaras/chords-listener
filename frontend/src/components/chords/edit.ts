// Chord editing: optimistic update of store.track + PATCH /api/tracks/<id>, undo and reset.
// Edits are stored canonically: sharps, un-transposed, regardless of the current display.

import { t } from '../../i18n'
import { resetTrack, updateTrack } from '../../lib/api'
import { formatChord, isNoChordLabel, parseChord } from '../../lib/music/chord'
import { SHARP_NAMES } from '../../lib/music/notes'
import { useApp } from '../../store'
import type { ChordSegment, Track } from '../../types'

/** Tracks that only exist in the browser (demo fixture) are edited locally. */
const LOCAL_TRACK_IDS = new Set(['demo'])
/** Detected chords of local tracks, kept so "reset" works without a backend. */
const localOriginals = new Map<string, ChordSegment[]>()

// lib/api routes to the connected server (same origin or the user's local server) or to the
// browser library for "local-…" tracks.
const api = { updateTrack, resetTrack }

/** Display label typed by the user → canonical stored label (or null if not a chord). */
export function toCanonical(input: string, transpose: number): string | null {
  if (isNoChordLabel(input)) return 'N'
  const p = parseChord(input)
  if (!p) return null
  return formatChord(
    { rootPc: p.rootPc - transpose, quality: p.quality, bassPc: p.bassPc == null ? null : p.bassPc - transpose },
    'sharp',
  )
}

function segmentFor(label: string, start: number, end: number): ChordSegment {
  const p = parseChord(label)
  return {
    start,
    end,
    label: p ? label : 'N',
    root: p ? SHARP_NAMES[p.rootPc] : null,
    quality: p ? p.quality : null,
    bass: p && p.bassPc != null ? SHARP_NAMES[p.bassPc] : null,
    confidence: 1,
  }
}

/** Merges neighbours with identical labels so segments stay minimal and contiguous. */
function mergeEqual(chords: ChordSegment[]): ChordSegment[] {
  const out: ChordSegment[] = []
  for (const c of chords) {
    const prev = out[out.length - 1]
    if (prev && prev.label === c.label && Math.abs(prev.end - c.start) < 0.05) {
      out[out.length - 1] = { ...prev, end: c.end, confidence: Math.min(prev.confidence, c.confidence) }
    } else out.push(c)
  }
  return out
}

function applyTrack(track: Track): void {
  const cur = useApp.getState().track
  if (cur && cur.id === track.id) useApp.setState({ track })
}

async function saveChords(track: Track, chords: ChordSegment[]): Promise<Track> {
  const optimistic: Track = { ...track, chords, edited: true, chordCount: chords.filter((c) => c.label !== 'N').length }
  applyTrack(optimistic)
  if (LOCAL_TRACK_IDS.has(track.id)) return optimistic
  const saved = await api.updateTrack(track.id, { chords })
  applyTrack(saved)
  return saved
}

/**
 * Replaces source segments [srcStart..srcEnd] (one display chord) with `canonical`.
 * Shows a toast with Undo; reverts and reports on failure.
 */
export async function editChord(srcStart: number, srcEnd: number, canonical: string, displayLabel: string): Promise<void> {
  const app = useApp.getState()
  const track = app.track
  if (!track) return
  const src = track.chords
  const a = src[srcStart]
  const b = src[srcEnd]
  if (!a || !b) return
  if (LOCAL_TRACK_IDS.has(track.id) && !track.edited) localOriginals.set(track.id, src)
  const next = mergeEqual([...src.slice(0, srcStart), segmentFor(canonical, a.start, b.end), ...src.slice(srcEnd + 1)])
  try {
    await saveChords(track, next)
    app.toast(t('chords.edit.saved', { chord: displayLabel === 'N' ? t('chords.noChord') : displayLabel }), 'success', {
      label: t('chords.edit.undo'),
      run: () => void undo(track),
    })
  } catch (e) {
    applyTrack(track)
    app.toast(t('chords.edit.failed', { error: e instanceof Error ? e.message : String(e) }), 'error')
  }
}

async function undo(previous: Track): Promise<void> {
  const app = useApp.getState()
  try {
    if (!previous.edited) await resetChords(true)
    else await saveChords(previous, previous.chords)
    app.toast(t('chords.edit.undone'), 'info')
  } catch (e) {
    app.toast(t('chords.edit.failed', { error: e instanceof Error ? e.message : String(e) }), 'error')
  }
}

/** Drops all user edits (POST /reset). */
export async function resetChords(silent = false): Promise<void> {
  const app = useApp.getState()
  const track = app.track
  if (!track) return
  try {
    if (LOCAL_TRACK_IDS.has(track.id)) {
      const original = localOriginals.get(track.id)
      if (original) applyTrack({ ...track, chords: original, edited: false })
    } else {
      applyTrack(await api.resetTrack(track.id))
    }
    if (!silent) app.toast(t('chords.edit.resetDone'), 'success')
  } catch (e) {
    app.toast(t('chords.edit.failed', { error: e instanceof Error ? e.message : String(e) }), 'error')
  }
}
