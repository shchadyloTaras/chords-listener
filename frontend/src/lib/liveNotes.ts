// Tiny event bus for notes that are sounding right now but are not part of the song's
// transcription — e.g. a chord preview played by clicking a chord. The live piano listens
// and lights these keys too, so the user sees what they hear.

export interface LiveNote {
  /** MIDI note number */
  midi: number
  /** performance.now() time (ms) when the note becomes audible */
  start: number
  /** performance.now() time (ms) when the note stops / has faded enough to release the key */
  end: number
  /** 0..1 */
  velocity: number
}

type Listener = (notes: readonly LiveNote[]) => void

const listeners = new Set<Listener>()

export function emitLiveNotes(notes: readonly LiveNote[]): void {
  if (!notes.length) return
  for (const l of listeners) l(notes)
}

/** Subscribe to preview notes; returns the unsubscribe function. */
export function onLiveNotes(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
