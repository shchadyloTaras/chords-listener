// Main-thread decoding: any browser-decodable audio/video -> mono Float32Array, resampled
// by the browser's own decoder straight to the analysis rate when it can.

export interface DecodedAudio {
  samples: Float32Array
  sampleRate: number
  /** seconds */
  duration: number
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext
type LiveCtor = new () => AudioContext

interface LegacyAudioGlobals {
  webkitOfflineAudioContext?: OfflineCtor
  webkitAudioContext?: LiveCtor
}

function offlineCtor(): OfflineCtor | undefined {
  return globalThis.OfflineAudioContext ?? (globalThis as LegacyAudioGlobals).webkitOfflineAudioContext
}

function liveCtor(): LiveCtor | undefined {
  return globalThis.AudioContext ?? (globalThis as LegacyAudioGlobals).webkitAudioContext
}

export function canDecodeAudio(): boolean {
  return Boolean(offlineCtor() ?? liveCtor())
}

function decodeWith(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    // callbacks for older Safari, the promise everywhere else (settling twice is a no-op)
    const fail = (err?: unknown) => reject(err instanceof Error ? err : new Error('the audio could not be decoded'))
    const p = ctx.decodeAudioData(data, resolve, fail) as Promise<AudioBuffer> | undefined
    if (p && typeof p.then === 'function') p.then(resolve, fail)
  })
}

function downmix(buf: AudioBuffer): Float32Array {
  const n = buf.length
  const channels = buf.numberOfChannels
  if (channels === 1) return buf.getChannelData(0).slice()
  const out = new Float32Array(n)
  for (let c = 0; c < channels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += ch[i]
  }
  const s = 1 / channels
  for (let i = 0; i < n; i++) out[i] *= s
  return out
}

/** Decode `data` (consumed) to mono PCM, preferably at `targetRate`. Rejects when the browser cannot decode it. */
export async function decodeToMono(data: ArrayBuffer, targetRate: number): Promise<DecodedAudio> {
  let ctx: BaseAudioContext | null = null
  let live: AudioContext | null = null
  const Offline = offlineCtor()
  if (Offline) {
    try {
      ctx = new Offline(1, 1, targetRate)
    } catch {
      ctx = null // unsupported rate: decode at the device rate, the worker resamples
    }
  }
  if (!ctx) {
    const Live = liveCtor()
    if (!Live) throw new Error('the Web Audio API is not available in this browser')
    live = new Live()
    ctx = live
  }
  try {
    const buf = await decodeWith(ctx, data)
    if (buf.length === 0 || buf.numberOfChannels === 0) throw new Error('the file contains no decodable audio')
    return { samples: downmix(buf), sampleRate: buf.sampleRate, duration: buf.duration }
  } finally {
    if (live) live.close().catch(() => undefined)
  }
}
