// Track audio → mono PCM at the model's 22 050 Hz. The browser's decodeAudioData runs on an
// OfflineAudioContext at that rate (it resamples with its own band-limited resampler while decoding);
// channels are averaged. Same decoder as the in-browser chord engine (lib/engine/decode.ts).
import { resample } from '../engine/core/resample.ts'
import { decodeToMono } from '../engine/decode.ts'
import { SAMPLE_RATE } from './basicPitch/constants.ts'

export interface ModelAudio {
  samples: Float32Array
  /** seconds */
  duration: number
}

export async function decodeForModel(blob: Blob): Promise<ModelAudio> {
  const audio = await decodeToMono(await blob.arrayBuffer(), SAMPLE_RATE)
  // decoded at the device rate when this browser cannot create a 22 050 Hz context
  const samples = audio.sampleRate === SAMPLE_RATE ? audio.samples : resample(audio.samples, audio.sampleRate, SAMPLE_RATE)
  return { samples, duration: audio.duration }
}
