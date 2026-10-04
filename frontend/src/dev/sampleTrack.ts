// Demo fixture for UI development (#/demo route, playground.html). Owned by the Chords agent.
// Confidences vary so a few chords show the low-confidence marker.
import type { ChordSegment, Track } from '../types'

const TEMPO = 96
const BEAT = 60 / TEMPO
const BAR = BEAT * 4

// [label, root, quality, bass, beats]
type Spec = [string, string | null, string | null, string | null, number]
const N: Spec = ['N', null, null, null, 4]
const c = (label: string, root: string, quality: string, beats = 4, bass: string | null = null): Spec => [label, root, quality, bass, beats]

const intro: Spec[] = [c('Am', 'A', 'min'), c('F', 'F', 'maj'), c('C', 'C', 'maj'), c('G', 'G', 'maj')]
const verse: Spec[] = [c('Am', 'A', 'min'), c('F', 'F', 'maj'), c('C', 'C', 'maj'), c('G', 'G', 'maj', 2), c('G/B', 'G', 'maj', 2, 'B')]
const chorus: Spec[] = [c('F', 'F', 'maj'), c('G', 'G', 'maj'), c('Em7', 'E', 'min7'), c('Am', 'A', 'min'), c('Dm7', 'D', 'min7'), c('G', 'G', 'maj', 2), c('Gsus4', 'G', 'sus4', 2), c('Cmaj7', 'C', 'maj7'), c('E7', 'E', '7')]
const bridge: Spec[] = [c('Dm', 'D', 'min'), c('G', 'G', 'maj'), c('C', 'C', 'maj'), c('Am', 'A', 'min'), c('Bdim', 'B', 'dim', 2), c('E', 'E', 'maj', 2)]

const song: Spec[] = [N, ...intro, ...intro, ...verse, ...verse, ...chorus, ...verse, ...chorus, ...bridge, ...chorus, ...intro, N]

function build(): { chords: ChordSegment[]; duration: number } {
  const chords: ChordSegment[] = []
  let t = 0
  song.forEach(([label, root, quality, bass, beats], i) => {
    const end = t + beats * BEAT
    const prev = chords[chords.length - 1]
    if (prev && prev.label === label) prev.end = end
    else chords.push({ start: t, end, label, root, quality, bass, confidence: 0.42 + ((i * 37) % 56) / 100 })
    t = end
  })
  return { chords, duration: t }
}

const { chords, duration } = build()
const beats = Array.from({ length: Math.floor(duration / BEAT) }, (_, i) => +(i * BEAT).toFixed(3))
const downbeats = beats.filter((_, i) => i % 4 === 0)
const waveform = Array.from({ length: 1200 }, (_, i) => {
  const x = i / 1200
  const env = Math.min(1, x * 12) * Math.min(1, (1 - x) * 10)
  const v = 0.35 + 0.35 * Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.051)) + 0.2 * Math.abs(Math.sin(i * 1.7))
  return +(env * Math.min(1, v)).toFixed(3)
})

export const sampleTrack: Track = {
  id: 'demo',
  title: 'Demo Song',
  artist: 'Chords Listener',
  duration,
  thumbnail: null,
  source: { type: 'file', filename: 'demo.mp3' },
  key: { tonic: 'A', mode: 'minor', name: 'Am', confidence: 0.82 },
  tempo: TEMPO,
  chordCount: chords.length,
  edited: false,
  createdAt: '2026-10-04T12:00:00Z',
  audioUrl: '',
  timeSignature: 4,
  beats,
  downbeats,
  chords,
  waveform,
  engine: 'demo',
}

export const DEMO_BAR_SECONDS = BAR
