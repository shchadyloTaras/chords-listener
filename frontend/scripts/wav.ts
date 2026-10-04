// Tiny RIFF/WAVE reader for Node-side tooling: PCM 8/16/24/32-bit and IEEE float 32/64,
// any channel count (downmixed to mono).

export interface WavAudio {
  samples: Float32Array
  sampleRate: number
  channels: number
}

export function readWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  let off = 12
  while (off + 8 <= bytes.length) {
    const id = tag(off)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      let format = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const rate = view.getUint32(body + 4, true)
      const bits = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true) // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, rate, bits }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk')
      const len = Math.min(size, bytes.length - body)
      return { samples: decodePcm(view, body, len, fmt), sampleRate: fmt.rate, channels: fmt.channels }
    }
    off = body + size + (size & 1)
  }
  throw new Error('WAV file has no data chunk')
}

function decodePcm(view: DataView, start: number, len: number,
  fmt: { format: number; channels: number; bits: number }): Float32Array {
  const bytesPer = fmt.bits / 8
  const frameBytes = bytesPer * fmt.channels
  const n = Math.floor(len / frameBytes)
  const out = new Float32Array(n)
  const read = sampleReader(view, fmt.format, fmt.bits)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < fmt.channels; c++) s += read(start + i * frameBytes + c * bytesPer)
    out[i] = s / fmt.channels
  }
  return out
}

function sampleReader(view: DataView, format: number, bits: number): (o: number) => number {
  if (format === 3 && bits === 32) return (o) => view.getFloat32(o, true)
  if (format === 3 && bits === 64) return (o) => view.getFloat64(o, true)
  if (format !== 1) throw new Error(`unsupported WAV format ${format}`)
  switch (bits) {
    case 8:
      return (o) => (view.getUint8(o) - 128) / 128
    case 16:
      return (o) => view.getInt16(o, true) / 32768
    case 24:
      return (o) => {
        const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)
        return v / 8388608
      }
    case 32:
      return (o) => view.getInt32(o, true) / 2147483648
    default:
      throw new Error(`unsupported PCM bit depth ${bits}`)
  }
}
