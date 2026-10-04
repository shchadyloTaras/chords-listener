// Note transcription for the live piano (Spotify's Basic Pitch on TF.js, in a worker).
//
//   const state = useTrackNotes(track)          // memory → saved notes → transcribe once and save
//   if (state.status === 'ready') state.index.activeAt(t)
//
// TF.js and the model load lazily (worker / dynamic import), never with the main bundle.
export {
  NOTES_ENGINE,
  modelUrl,
  releaseNotes,
  requestNotes,
  resetNotesService,
  retainNotes,
  useNotesStore,
  useTrackNotes,
  type NotesErrorCode,
  type NotesState,
} from './service'
export { NoteIndex, BUCKET_SECONDS } from './noteIndex'
export {
  decodeNotes,
  encodeNotes,
  validateNotes,
  toEvents,
  NotesFormatError,
  MAX_NOTES,
  MIDI_HIGH,
  MIDI_LOW,
  type NoteArrays,
  type NoteEvent,
} from './compact'
export type { TfBackend, TranscribeStats } from './protocol'
