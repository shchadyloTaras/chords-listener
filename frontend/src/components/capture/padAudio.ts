// Browser mode keeps recordings of a YouTube video in the video's time base: when the recording began at
// `startOffset` > 0, the stored audio gets that much silence in front, so the detected chords, the audio
// player and the embedded video all agree (the cloud stores the offset instead, see docs/CLOUD.md).

/** 16-bit PCM WAV of mono samples (−1..1). */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, bytes, true)
  let o = 44
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0))
    view.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Sample rate of the padded copy: enough for listening, small enough for long songs in IndexedDB. */
export function paddedRate(totalSeconds: number): number {
  return totalSeconds <= 12 * 60 ? 32_000 : 22_050
}

/**
 * Decodes a recording and returns it as a mono WAV that starts with `offsetS` seconds of silence.
 * Rejects when the browser cannot decode the recording.
 */
export async function padAudioStart(audio: Blob, offsetS: number): Promise<Blob> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx || typeof OfflineAudioContext === 'undefined') throw new Error('Web Audio is not available')
  const ctx = new Ctx()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await audio.arrayBuffer())
  } finally {
    void ctx.close().catch(() => undefined)
  }
  const total = offsetS + decoded.duration
  const rate = paddedRate(total)
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(total * rate)), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(offsetS)
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), rate)
}
