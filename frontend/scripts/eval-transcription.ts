// Accuracy and speed of the live-piano note transcription (Basic Pitch + our decoder) on synthetic
// music with KNOWN notes. Runs the exact code the browser worker runs, on the TF.js CPU backend.
//
//   cd frontend && node scripts/eval-transcription.ts                 # 3 clips (~65 s of audio)
//        [--seconds 30] [--cache DIR] [--params '{"onsetThresh":0.45}'] [--json out.json] [-v]
//        [--wav-out DIR]          also write each clip as DIR/<name>.wav + DIR/<name>.notes.json
//        [--wav FILE.wav ...]     transcribe your own WAV files (speed + note count only)
//
// Metrics (mir_eval-style, onset-only): a detected note matches a reference note of the same pitch
// whose onset is within ±50 ms (greedy by closest onset, one-to-one). Precision / recall / F1 over
// notes; onset error statistics over matched notes; frame-level precision / recall of "which keys
// are down" sampled every 10 ms. "reference timing" re-times the same notes with basic-pitch's
// noteFramesToTime approximation for comparison.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import * as tf from '@tensorflow/tfjs-core'
import '@tensorflow/tfjs-backend-cpu'
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter'
import { resample } from '../src/lib/engine/core/resample.ts'
import { SAMPLE_RATE } from '../src/lib/transcription/basicPitch/constants.ts'
import { runModel, type Posteriorgram } from '../src/lib/transcription/basicPitch/infer.ts'
import { posteriorgramToNotes, type NoteEvent, type NoteParams } from '../src/lib/transcription/basicPitch/notes.ts'
import { evaluationClips, wavBytes, type Clip, type TruthNote } from './transcription-synth.ts'
import { readWav } from './wav.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = resolve(HERE, '../public/models/basic-pitch')
const TOL = 0.05

interface Args {
  seconds: number
  cache: string | null
  params: Partial<NoteParams>
  json: string | null
  verbose: boolean
  wavOut: string | null
  wavs: string[]
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seconds: 30, cache: null, params: {}, json: null, verbose: false, wavOut: null, wavs: [] }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--seconds') a.seconds = Number(argv[++i])
    else if (k === '--cache') a.cache = argv[++i]
    else if (k === '--params') a.params = JSON.parse(argv[++i]) as Partial<NoteParams>
    else if (k === '--json') a.json = argv[++i]
    else if (k === '--wav-out') a.wavOut = argv[++i]
    else if (k === '--wav') while (argv[i + 1] && !argv[i + 1].startsWith('-')) a.wavs.push(argv[++i])
    else if (k === '-v' || k === '--verbose') a.verbose = true
    else if (k === '-h' || k === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 14).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown argument ${k}`)
  }
  return a
}

async function loadModel(): Promise<GraphModel> {
  const json = JSON.parse(readFileSync(join(MODEL_DIR, 'model.json'), 'utf8')) as {
    modelTopology: object
    weightsManifest: { paths: string[]; weights: tf.io.WeightsManifestEntry[] }[]
    format?: string
    signature?: object
  }
  const parts = json.weightsManifest.flatMap((g) => g.paths.map((p) => readFileSync(join(MODEL_DIR, p))))
  const bytes = Buffer.concat(parts)
  return loadGraphModel(
    tf.io.fromMemory({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest.flatMap((g) => g.weights),
      weightData: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      format: json.format,
      signature: json.signature,
    }),
  )
}

// ------------------------------------------------------------------ metrics

interface Match {
  ref: TruthNote
  est: NoteEvent
  err: number
}

function matchNotes(ref: TruthNote[], est: NoteEvent[]): Match[] {
  const pairs: { i: number; j: number; d: number }[] = []
  for (let i = 0; i < ref.length; i++) {
    for (let j = 0; j < est.length; j++) {
      if (ref[i].midi !== est[j].midi) continue
      const d = est[j].start - ref[i].start
      if (Math.abs(d) <= TOL) pairs.push({ i, j, d })
    }
  }
  pairs.sort((a, b) => Math.abs(a.d) - Math.abs(b.d))
  const usedR = new Set<number>()
  const usedE = new Set<number>()
  const out: Match[] = []
  for (const p of pairs) {
    if (usedR.has(p.i) || usedE.has(p.j)) continue
    usedR.add(p.i)
    usedE.add(p.j)
    out.push({ ref: ref[p.i], est: est[p.j], err: p.d })
  }
  return out
}

function frameScores(ref: TruthNote[], est: NoteEvent[], duration: number) {
  let tp = 0
  let fp = 0
  let fn = 0
  for (let t = 0; t < duration; t += 0.01) {
    const r = new Set(ref.filter((n) => n.start <= t && t < n.end).map((n) => n.midi))
    const e = new Set(est.filter((n) => n.start <= t && t < n.end).map((n) => n.midi))
    for (const m of e) if (r.has(m)) tp++
    else fp++
    for (const m of r) if (!e.has(m)) fn++
  }
  return { p: tp / Math.max(1, tp + fp), r: tp / Math.max(1, tp + fn) }
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]
}

interface Score {
  name: string
  refNotes: number
  estNotes: number
  precision: number
  recall: number
  f1: number
  onsetBiasMs: number
  onsetMedianAbsMs: number
  onsetP90AbsMs: number
  frameP: number
  frameR: number
}

function score(name: string, ref: TruthNote[], est: NoteEvent[], duration: number): Score & { matches: Match[] } {
  const matches = matchNotes(ref, est)
  const precision = matches.length / Math.max(1, est.length)
  const recall = matches.length / Math.max(1, ref.length)
  const errs = matches.map((m) => m.err)
  const fr = frameScores(ref, est, duration)
  return {
    name,
    refNotes: ref.length,
    estNotes: est.length,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    onsetBiasMs: errs.length ? (1000 * errs.reduce((a, b) => a + b, 0)) / errs.length : NaN,
    onsetMedianAbsMs: 1000 * quantile(errs.map(Math.abs), 0.5),
    onsetP90AbsMs: 1000 * quantile(errs.map(Math.abs), 0.9),
    frameP: fr.p,
    frameR: fr.r,
    matches,
  }
}

/** basic-pitch's noteFramesToTime timing for the same notes (frame index → seconds approximation). */
function referenceTiming(notes: NoteEvent[], pg: Posteriorgram): NoteEvent[] {
  const WINDOW_OFFSET = (256 / 22050) * (172 - (22050 * 2 - 256) / 256) + 0.0018
  const frameOf = (t: number) => {
    // nearest frame index of time t in our exact table
    let lo = 0
    let hi = pg.times.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pg.times[mid] < t) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && Math.abs(pg.times[lo - 1] - t) < Math.abs(pg.times[lo] - t) ? lo - 1 : lo
  }
  const official = (f: number) => (f * 256) / 22050 - WINDOW_OFFSET * Math.floor(f / 172)
  return notes.map((n) => ({ ...n, start: official(frameOf(n.start)), end: official(frameOf(n.end)) }))
}

// ------------------------------------------------------------------ main

async function posteriorgram(model: GraphModel, clip: Clip, cache: string | null): Promise<{ pg: Posteriorgram; seconds: number }> {
  const file = cache ? join(cache, `${clip.name}-${clip.samples.length}.pg.bin`) : null
  if (file && existsSync(file)) {
    const raw = readFileSync(file)
    const f64 = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const n = f64[0]
    const seconds = f64[1]
    const times = f64.slice(2, 2 + n)
    const f32 = new Float32Array(f64.buffer, (2 + n) * 8)
    return { pg: { nFrames: n, times, frames: f32.slice(0, n * 88), onsets: f32.slice(n * 88, 2 * n * 88) }, seconds }
  }
  const t0 = performance.now()
  const samples = resample(clip.samples, clip.sampleRate, SAMPLE_RATE)
  let last = -1
  const pg = await runModel(model, samples, {
    onProgress: ({ windowsDone, windowsTotal }) => {
      const pctDone = Math.floor((100 * windowsDone) / windowsTotal)
      if (pctDone >= last + 10) {
        last = pctDone
        process.stderr.write(`\r  ${clip.name}: model ${pctDone}%   `)
      }
    },
  })
  process.stderr.write('\r' + ' '.repeat(60) + '\r')
  const seconds = (performance.now() - t0) / 1000
  if (file) {
    mkdirSync(dirname(file), { recursive: true })
    const out = new ArrayBuffer((2 + pg.nFrames) * 8 + 2 * pg.nFrames * 88 * 4)
    const f64 = new Float64Array(out, 0, 2 + pg.nFrames)
    f64[0] = pg.nFrames
    f64[1] = seconds
    f64.set(pg.times, 2)
    const f32 = new Float32Array(out, (2 + pg.nFrames) * 8)
    f32.set(pg.frames, 0)
    f32.set(pg.onsets, pg.nFrames * 88)
    writeFileSync(file, Buffer.from(out))
  }
  return { pg, seconds }
}

function table(rows: Score[]): void {
  console.log(
    ['clip'.padEnd(22), 'ref', 'est', 'P', 'R', 'F1', 'bias ms', '|err| med', '|err| p90', 'frame P', 'frame R'].join('\t'),
  )
  for (const s of rows) {
    console.log(
      [
        s.name.padEnd(22),
        s.refNotes,
        s.estNotes,
        pct(s.precision),
        pct(s.recall),
        pct(s.f1),
        s.onsetBiasMs.toFixed(1),
        s.onsetMedianAbsMs.toFixed(1),
        s.onsetP90AbsMs.toFixed(1),
        pct(s.frameP),
        pct(s.frameR),
      ].join('\t'),
    )
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await tf.setBackend('cpu')
  const model = await loadModel()

  if (args.wavs.length) {
    for (const path of args.wavs) {
      const wav = readWav(new Uint8Array(readFileSync(path)))
      const clip: Clip = { name: path, sampleRate: wav.sampleRate, samples: wav.samples, notes: [], duration: wav.samples.length / wav.sampleRate }
      const { pg, seconds } = await posteriorgram(model, clip, null)
      const t0 = performance.now()
      const notes = posteriorgramToNotes(pg, args.params)
      const post = (performance.now() - t0) / 1000
      console.log(`${path}: ${clip.duration.toFixed(1)} s audio → ${notes.length} notes; model ${seconds.toFixed(1)} s (${((60 * seconds) / clip.duration).toFixed(1)} s per minute, CPU backend), decoding ${(1000 * post).toFixed(0)} ms`)
    }
    return
  }

  const clips = evaluationClips(args.seconds)
  const ours: Score[] = []
  const theirs: Score[] = []
  let audio = 0
  let modelSeconds = 0
  let postSeconds = 0
  const allRef: TruthNote[] = []
  const allEst: NoteEvent[] = []
  const allRefTimed: NoteEvent[] = []
  let offset = 0
  for (const clip of clips) {
    if (args.wavOut) {
      mkdirSync(args.wavOut, { recursive: true })
      writeFileSync(join(args.wavOut, `${clip.name}.wav`), wavBytes(clip))
      writeFileSync(join(args.wavOut, `${clip.name}.notes.json`), JSON.stringify({ duration: clip.duration, notes: clip.notes }))
    }
    const { pg, seconds } = await posteriorgram(model, clip, args.cache)
    const t0 = performance.now()
    const est = posteriorgramToNotes(pg, args.params)
    postSeconds += (performance.now() - t0) / 1000
    modelSeconds += seconds
    audio += clip.duration
    const s = score(clip.name, clip.notes, est, clip.duration)
    ours.push(s)
    const refTimed = referenceTiming(est, pg)
    theirs.push(score(clip.name, clip.notes, refTimed, clip.duration))
    if (args.verbose) {
      const missed = clip.notes.filter((r) => !s.matches.some((m) => m.ref === r))
      const extra = est.filter((e) => !s.matches.some((m) => m.est === e))
      console.log(`\n${clip.name}: missed ${missed.length}, extra ${extra.length}`)
      for (const m of missed.slice(0, 12)) console.log(`  missed midi ${m.midi} @ ${m.start.toFixed(3)}`)
      for (const e of extra.slice(0, 12)) console.log(`  extra  midi ${e.midi} @ ${e.start.toFixed(3)}–${e.end.toFixed(3)} v${e.velocity}`)
    }
    allRef.push(...clip.notes.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })))
    allEst.push(...est.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })))
    allRefTimed.push(...refTimed.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })))
    offset += clip.duration + 10
  }
  const total = score('ALL', allRef, allEst, offset)
  const totalRef = score('ALL', allRef, allRefTimed, offset)
  console.log('\nOur timing (exact frame times + sub-frame onset refinement):')
  table([...ours, total])
  console.log('\nSame notes with basic-pitch noteFramesToTime timing:')
  table([...theirs, totalRef])
  console.log(
    `\nAudio ${audio.toFixed(1)} s · model ${modelSeconds.toFixed(1)} s on the TF.js CPU backend = ${((60 * modelSeconds) / audio).toFixed(1)} s per minute of audio · decoding ${(1000 * postSeconds).toFixed(0)} ms`,
  )
  if (args.json) {
    const strip = (s: Score & { matches?: unknown }) => {
      const { matches: _m, ...rest } = s
      return rest
    }
    writeFileSync(args.json, JSON.stringify({ ours: [...ours, total].map(strip), reference: [...theirs, totalRef].map(strip), audio, modelSeconds, postSeconds }, null, 2))
  }
}

await main()
