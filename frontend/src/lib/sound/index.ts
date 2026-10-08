// Chord sound: clicking a chord plays it on the selected instrument (Web Audio, synthesized; no
// samples). See docs/SPEC.md "Chord sound".

import { renderOffline, soundEngine } from './engine'

export {
  clickChordSound,
  chordSoundNotes,
  pickSongChord,
  playChordSound,
  playDronePreview,
  playHandpanField,
  playHarmoniumKey,
  playHotkeyChord,
  playPianoKey,
  playTestSound,
  type SongChords,
  type SoundOptions,
} from './play'
export { ringElement, type RingStyle } from './feedback'
export { useSoundingTargets } from './sounding'
export { alongVolumeGain, PLAY_ALONG_MAX_VOLUME, renderOffline, soundEngine, volumeGain, type PlayRequest, type SoundStats } from './engine'
export type { NoteEvent } from './chordNotes'
export { droneMidi } from './drone'

// Development: inspect scheduling from the console — window.__chordSound.stats (plays, voices,
// active voices, the last live notes, context state) and .renderOffline(request) for level checks.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __chordSound?: unknown }).__chordSound = {
    engine: soundEngine,
    get stats() {
      return soundEngine.stats
    },
    renderOffline,
  }
}
