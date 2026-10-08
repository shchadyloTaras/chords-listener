/** A short mono 16-bit PCM WAV (a sine tone): a real audio file for the site's upload path. */
export function wav(seconds = 1, frequency = 440, sampleRate = 8000): Buffer {
  const samples = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
