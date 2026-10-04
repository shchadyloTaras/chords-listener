// Full score from a track: quantized vocal melody + piano arrangement + chord symbols, written as
// MusicXML or MIDI (pure, no DOM). The PDF export (OpenSheetMusicDisplay + jsPDF) lives in ./pdf and
// is loaded on demand only.
export { buildScore, rowsFromArrays, type ScoreInput, type ScoreLabels } from './build'
export { chordSymbolsFromBars, harmonyOf } from './chordSymbols'
export { toMidi, PPQ } from './midi'
export { toMusicXml, escapeXml } from './musicxml'
export { notate, beam, noteFits, restFits, splitValues } from './notation'
export { arrangePiano, capChord, splitPoints, PIANO, type PianoHands, type PianoOptions } from './piano'
export { keySignature, keySigName, spellMidi, spellPc, keyAlter, type KeySig } from './spelling'
export { buildTimeMap, quantize, DIV, type Measure, type TimeMap } from './timeMap'
export { quantizeVocal, medianPitch, type NoteRow, type VocalOptions } from './vocal'
export * from './types'
