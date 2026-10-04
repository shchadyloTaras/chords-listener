import { describe, expect, it } from 'vitest'
import { encodeWav, paddedRate } from './padAudio'

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM WAV', async () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), 32000)
    expect(wav.type).toBe('audio/wav')
    const view = new DataView(await wav.arrayBuffer())
    const text = (o: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(32000)
    expect(view.getUint32(40, true)).toBe(10)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
    expect(view.getInt16(52, true)).toBe(32767) // clipped
  })

  it('keeps long recordings small', () => {
    expect(paddedRate(4 * 60)).toBe(32000)
    expect(paddedRate(25 * 60)).toBe(22050)
  })
})
