// App-facing chord sound: plays a displayed chord label on the selected instrument exactly as its
// diagram shows it (transpose / simplify / spelling are already in the label), decides when an
// implicit click should sound, and serves the P hotkey and the settings' test button.

import { selectionRange, useChordUi } from '../../components/chords/uiStore'
import { t } from '../../i18n'
import { useApp, type Instrument } from '../../store'
import { getLoadedDb, loadChordDb, type ChordDb, type FretInstrument } from '../diagrams/chordsDb'
import { fretVoicings } from '../diagrams/fretted'
import { resolveScale } from '../handpan'
import { keyInstrument } from '../instruments'
import { parseChord, type ParsedChord } from '../music/chord'
import {
  fallbackFretNotes,
  fretChordNotes,
  handpanChordNotes,
  handpanFieldNote,
  harmoniumChordNotes,
  pianoChordNotes,
  pianoKeyNote,
  pickChordIndex,
  type ChordSpan,
  type NoteEvent,
} from './chordNotes'
import { soundEngine } from './engine'
import { ringElement, type RingStyle } from './feedback'

export interface SoundOptions {
  /** defaults to the selected instrument */
  instrument?: Instrument
  /** element that gets the brief "pressed / ringing" feedback */
  from?: Element | null
  /** feedback colour (usually the chord colour) */
  color?: string
  feedback?: RingStyle
}

/** How long a click waits for the guitar / ukulele shapes to load before using a plain voicing. */
const DB_WAIT_MS = 800

function handpanScale() {
  const s = useApp.getState()
  return resolveScale(s.handpanScale, s.handpanNotes)
}

/** The voicing the diagram shows: same lookup, same chosen index (ChordDiagram). */
function fretNotes(db: ChordDb | null, instrument: FretInstrument, label: string, parsed: ParsedChord): NoteEvent[] {
  const found = fretVoicings(instrument, parsed, db)
  const count = found?.voicings.length ?? 0
  if (!found || !count) return instrument === 'bass' ? [] : fallbackFretNotes(parsed, instrument)
  const chosen = useChordUi.getState().voicings[`${instrument}:${label}`] ?? 0
  return fretChordNotes(found.voicings[((chosen % count) + count) % count], instrument)
}

/** Notes for a chord label on an instrument; a promise only while the guitar / ukulele shapes still load. */
export function chordSoundNotes(label: string, instrument: Instrument): NoteEvent[] | Promise<NoteEvent[]> {
  const parsed = parseChord(label)
  if (!parsed) return []
  if (instrument === 'piano') return pianoChordNotes(label)
  if (instrument === 'harmonium') return harmoniumChordNotes(label)
  if (instrument === 'handpan') return handpanChordNotes(label, handpanScale())
  if (instrument === 'bass') return fretNotes(null, 'bass', label, parsed)
  const db = getLoadedDb(instrument)
  if (db) return fretNotes(db, instrument, label, parsed)
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), DB_WAIT_MS))
  return Promise.race([loadChordDb(instrument).catch(() => null), timeout]).then((loaded) =>
    fretNotes(loaded ?? getLoadedDb(instrument), instrument, label, parsed),
  )
}

let warned = false
function unavailable(): void {
  if (warned) return
  warned = true
  useApp.getState().toast(t('sound.unavailable'), 'info')
}

function feedback(opts: SoundOptions): void {
  ringElement(opts.from, opts.color, opts.feedback ?? 'ring')
}

let chordRequest = 0

/**
 * Plays a chord now (explicit: play buttons, diagrams, P — ignores the click setting). Silent for
 * "N" / unknown labels; on a handpan without any of the chord's notes it plays nothing and says so.
 * Returns whether a sound was started.
 */
export function playChordSound(label: string, opts: SoundOptions = {}): boolean {
  const parsed = parseChord(label)
  if (!parsed) return false
  const instrument = opts.instrument ?? useApp.getState().instrument
  if (!soundEngine.unlock()) {
    unavailable()
    return false
  }
  const request = ++chordRequest
  const start = (notes: NoteEvent[]) => {
    if (request !== chordRequest) return
    void soundEngine.play({ instrument, kind: 'chord', label, notes })
  }
  const notes = chordSoundNotes(label, instrument)
  if (Array.isArray(notes)) {
    if (!notes.length) {
      if (instrument === 'handpan') useApp.getState().toast(t('sound.handpan.none', { chord: label }), 'info')
      return false
    }
    feedback(opts)
    start(notes)
  } else {
    feedback(opts)
    void notes.then(start)
  }
  return true
}

/**
 * Implicit click-to-play (sheet, timeline, legend, hero): only with the "chord sound on click"
 * setting, and with `unlessPlaying` not while the song plays (the click seeks there and the
 * recording itself is heard). Returns whether the click was meant to sound.
 */
export function clickChordSound(label: string, opts: SoundOptions & { unlessPlaying?: boolean } = {}): boolean {
  const s = useApp.getState()
  if (!s.chordSound || (opts.unlessPlaying && s.isPlaying)) return false
  playChordSound(label, opts)
  return true
}

/** One key of a chord's keyboard diagram (key 0 = C4), on the harmonium when `opts.instrument` is it, else the piano. */
export function playPianoKey(label: string, key: number, opts: SoundOptions = {}): void {
  if (!soundEngine.unlock()) return unavailable()
  feedback(opts)
  void soundEngine.play({ instrument: keyInstrument(opts.instrument), kind: 'note', label, notes: [pianoKeyNote(key)] })
}

/** One field (0 = ding) of the selected handpan, in a chord's handpan diagram. */
export function playHandpanField(label: string, index: number, opts: SoundOptions = {}): void {
  const note = handpanFieldNote(handpanScale(), index)
  if (!note) return
  if (!soundEngine.unlock()) return unavailable()
  feedback(opts)
  void soundEngine.play({ instrument: 'handpan', kind: 'note', label, notes: [note] })
}

export interface SongChords {
  chords: readonly (ChordSpan & { label: string })[]
  bars: readonly { start: number; end: number }[]
}

/** The chord P plays: the current one, else the first of the bar selection, else the next one. */
export function pickSongChord(song: SongChords, time: number): string | null {
  const range = selectionRange(useChordUi.getState().selection)
  const a = range ? song.bars[range[0]] : undefined
  const b = range ? song.bars[range[1]] : undefined
  const i = pickChordIndex(song.chords, time, a && b ? { start: a.start, end: b.end } : null)
  return i >= 0 ? song.chords[i].label : null
}

/** The P hotkey. */
export function playHotkeyChord(song: SongChords, time: number): boolean {
  const label = pickSongChord(song, time)
  return label != null && playChordSound(label)
}

/** The settings' test button: the chord P would play, or C when the song has none. */
export function playTestSound(song: SongChords | null, time: number, from?: Element | null): void {
  playChordSound((song && pickSongChord(song, time)) ?? 'C', { from })
}

/**
 * Pressing (mouse) on anything that may sound starts the audio context already, so it is running
 * by the time the click lands. Elements opt in with data-cw-sound="always" | "click" (only with the
 * click setting) | "seek" (click setting, and only while the song is paused). Touch presses are no
 * user activation yet; the click itself unlocks there.
 */
function warmUp(e: PointerEvent): void {
  if (e.pointerType !== 'mouse' || e.button !== 0) return
  const el = (e.target as Element | null)?.closest?.('[data-cw-sound]')
  if (!el) return
  const mode = el.getAttribute('data-cw-sound')
  const s = useApp.getState()
  if (mode !== 'always' && (!s.chordSound || (mode === 'seek' && s.isPlaying))) return
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  if (activation && !activation.isActive) return
  soundEngine.unlock()
}

if (typeof window !== 'undefined') window.addEventListener('pointerdown', warmUp, { capture: true, passive: true })
