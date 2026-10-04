// Basic Pitch model constants (spotify/basic-pitch, basic_pitch/constants.py), Apache-2.0.

/** The model consumes mono audio at this rate. */
export const SAMPLE_RATE = 22050
/** Hop of the model's CQT: one output frame per 256 samples (~11.6 ms). */
export const FFT_HOP = 256
/** Samples per model window (2 s minus one hop). */
export const WINDOW_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP
/** Output frames per window (centered CQT frames at 0, 256, … within the window). */
export const FRAMES_PER_WINDOW = 172
/** Consecutive windows overlap by this many frames; half of it is trimmed on each side. */
export const OVERLAP_FRAMES = 30
export const TRIM_FRAMES = OVERLAP_FRAMES / 2
export const OVERLAP_SAMPLES = OVERLAP_FRAMES * FFT_HOP
/** Window start step (audio samples). */
export const WINDOW_HOP = WINDOW_SAMPLES - OVERLAP_SAMPLES
/** Frames kept from each window after trimming the overlap. */
export const FRAMES_KEPT = FRAMES_PER_WINDOW - OVERLAP_FRAMES
/** Zero padding in front of the audio so the first kept frame is centered on sample 0. */
export const LEAD_PADDING = OVERLAP_SAMPLES / 2

/** Pitch bins of the note outputs: the 88 piano keys, A0 (MIDI 21) … C8 (MIDI 108). */
export const N_PITCHES = 88
export const MIDI_OFFSET = 21
export const MIDI_MIN = MIDI_OFFSET
export const MIDI_MAX = MIDI_OFFSET + N_PITCHES - 1

/** Graph output tensor names (frames = note activations, onsets, contours = pitch salience). */
export const OUTPUT_FRAMES = 'Identity_1'
export const OUTPUT_ONSETS = 'Identity_2'

/** Exact audio time (s) of kept frame `j` of window `w`. */
export function frameTime(w: number, j: number): number {
  return (w * WINDOW_HOP + j * FFT_HOP) / SAMPLE_RATE
}
