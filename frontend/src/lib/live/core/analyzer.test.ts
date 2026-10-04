import { describe, expect, it } from 'vitest'
import { analyzeSignal } from '../../engine/core/analyze.ts'
import { resample } from '../../engine/core/resample.ts'
import { SR } from '../../engine/core/spectrum.ts'
import { rng } from '../../engine/testing/synth.ts'
import { SONGS, agreement, renderSong, type RenderedSong } from '../testing/songs.ts'
import { LiveAnalyzer, chromaEntropy, type AnalyzerChord, type LiveAnalysisState } from './analyzer.ts'

const RATE = 48000

interface Played {
  finals: AnalyzerChord[]
  states: LiveAnalysisState[]
  analyzer: LiveAnalyzer
}

/** Stream `x` through a LiveAnalyzer in random chunks, taking a state every 100 ms of audio. */
function play(x: Float32Array, rate: number, seed = 1): Played {
  const analyzer = new LiveAnalyzer({ inputRate: rate })
  const r = rng(seed)
  const finals: AnalyzerChord[] = []
  const states: LiveAnalysisState[] = []
  let next = 0.1
  for (let i = 0; i < x.length; ) {
    const n = 128 + Math.floor(r() * 4000)
    analyzer.push(x.subarray(i, i + n))
    i += n
    if (analyzer.time >= next) {
      next += 0.1
      const st = analyzer.state()
      finals.push(...st.finalized)
      states.push(st)
    }
  }
  finals.push(...analyzer.state().finalized, ...analyzer.finish())
  return { finals, states, analyzer }
}

describe('LiveAnalyzer on synthesized songs (48 kHz input)', () => {
  const runs = SONGS.map((spec) => {
    const song = renderSong(spec, SR)
    const input = resample(song.audio, SR, RATE)
    return { song, played: play(input, RATE, spec.bpm) }
  })
  const byName = (name: string) => runs.find((r) => r.song.spec.name === name)!

  it('final chords match the known progression and the offline engine', () => {
    for (const { song, played } of runs) {
      const name = song.spec.name
      expect(agreement(played.finals, song.truth, 0, song.duration), `${name} vs truth`).toBeGreaterThanOrEqual(0.93)
      // away from the changes themselves (boundary placement within 150 ms)
      expect(agreement(played.finals, song.truth, 0, song.duration, 0.15), `${name} vs truth (guard)`).toBeGreaterThanOrEqual(0.98)
      // vs the offline engine over the music (offline names the noise-only lead-in of the noisy song a chord)
      const offline = analyzeSignal(song.audio, SR)
      const musicEnd = song.truth[song.truth.length - 2].end
      expect(agreement(played.finals, offline.chords, song.changes[0], musicEnd), `${name} vs offline`).toBeGreaterThanOrEqual(0.93)
    }
  })

  it('shows each new chord as the current one within ~0.75 s of audio (algorithmic latency)', () => {
    const lat: number[] = []
    for (const { song, played } of runs) {
      for (const seg of song.truth.slice(1)) {
        if (seg.label === 'N') continue
        const hit = played.states.find((s) => {
          const cur = s.open[s.open.length - 1]
          return s.time >= seg.start && cur?.label === seg.label && cur.start >= seg.start - 0.35
        })
        expect(hit, `${song.spec.name}: ${seg.label} at ${seg.start}`).toBeDefined()
        lat.push(hit!.time - seg.start)
      }
    }
    lat.sort((a, b) => a - b)
    expect(lat[lat.length >> 1]).toBeLessThan(0.7)
    expect(lat[lat.length - 1]).toBeLessThan(0.85)
  })

  it('reports chords provisional first and final once, contiguous from 0 to the end', () => {
    for (const { song, played } of runs) {
      let end = 0
      for (const c of played.finals) {
        expect(c.provisional).toBe(false)
        expect(c.start).toBeCloseTo(end, 6)
        expect(c.end).toBeGreaterThan(c.start)
        end = c.end
      }
      expect(end).toBeCloseTo(song.duration, 2)
      // every final chord (after the lead-in) was on screen as a provisional current chord before
      for (const f of played.finals.slice(1)) {
        if (f.label === 'N') continue
        const firstSeen = played.states.find((s) => s.open.some((o) => o.label === f.label && Math.abs(o.start - f.start) < 0.4))
        expect(firstSeen, `${song.spec.name}: ${f.label}@${f.start}`).toBeDefined()
      }
      // the current chord is never final; open chords never overlap the finals
      let finalEnd = 0
      for (const s of played.states) {
        for (const f of s.finalized) finalEnd = f.end
        if (s.open.length) expect(s.open[0].start).toBeCloseTo(finalEnd, 6)
        s.open.forEach((o, i) => i > 0 && expect(o.start).toBeCloseTo(s.open[i - 1].end, 6))
      }
    }
  })

  it('confirms the current chord after the smoothing lag', () => {
    const { song, played } = byName('pop-120')
    for (const seg of song.truth.slice(1, -1)) {
      const seen = played.states.filter((s) => s.open[s.open.length - 1]?.label === seg.label && s.time >= seg.start && s.time < seg.end + 1)
      const first = seen[0]
      const confirmed = seen.find((s) => !s.open[s.open.length - 1].provisional)
      expect(first.open[first.open.length - 1].provisional).toBe(true)
      expect(confirmed).toBeDefined()
      // lag (0.74 s) + feature delay (0.37 s) + minimum duration
      expect(confirmed!.time - seg.start).toBeLessThan(1.6)
    }
  })

  it('estimates key, tempo and a detuned reference pitch', () => {
    const expectKey = { 'pop-120': 'C', 'sevenths-100': 'C', 'fast-132': 'E', 'noisy-minor-96': 'Am', 'detuned-110': 'D' } as Record<string, string>
    for (const { song, played } of runs) {
      const last = played.states[played.states.length - 1]
      expect(last.key?.name, song.spec.name).toBe(expectKey[song.spec.name])
      expect(Math.abs((last.tempo ?? 0) - song.spec.bpm), song.spec.name).toBeLessThan(3)
    }
    const detuned = byName('detuned-110').played.states.at(-1)!
    expect(detuned.tuning).toBeCloseTo(0.35, 1)
    expect(byName('pop-120').played.states.at(-1)!.tuning).toBeCloseTo(0, 1)
  })

  it('reports the input level for a meter', () => {
    const { played } = byName('pop-120')
    const levels = played.states.map((s) => s.level)
    expect(Math.min(...levels.slice(0, 5))).toBe(0) // silent lead-in
    expect(Math.max(...levels)).toBeGreaterThan(0.6)
    expect(Math.max(...levels)).toBeLessThanOrEqual(1)
  })
})

describe('LiveAnalyzer edge cases', () => {
  const finalLabels = (p: Played) => p.finals.map((c) => c.label)

  it('silence is "N"', () => {
    const p = play(new Float32Array(3 * RATE), RATE)
    expect(finalLabels(p)).toEqual(['N'])
    expect(p.states.every((s) => s.level === 0)).toBe(true)
  })

  it('broadband noise is "N"', () => {
    const r = rng(3)
    const x = Float32Array.from({ length: 5 * RATE }, () => 0.17 * (2 * r() - 1)) // ~-20 dBFS
    const p = play(x, RATE)
    const n = p.finals.filter((c) => c.label === 'N').reduce((s, c) => s + c.end - c.start, 0)
    expect(n / 5).toBeGreaterThan(0.95)
    expect(chromaEntropy(new Float32Array(12).fill(1))).toBeCloseTo(1, 9)
  })

  it('survives non-finite samples and odd sample rates', () => {
    const song: RenderedSong = renderSong(SONGS[0], SR)
    const x = resample(song.audio, SR, 44100)
    for (let i = 0; i < x.length; i += 1013) x[i] = i % 2 ? NaN : Infinity
    const p = play(x, 44100)
    expect(agreement(p.finals, song.truth, 0, song.duration, 0.15)).toBeGreaterThan(0.95)
  })

  it('finish() is idempotent and push() after it is ignored', () => {
    const a = new LiveAnalyzer({ inputRate: RATE })
    a.push(new Float32Array(RATE))
    expect(a.finish().map((c) => c.label)).toEqual(['N'])
    expect(a.finish()).toEqual([])
    a.push(new Float32Array(RATE))
    expect(a.time).toBe(1)
  })
})
