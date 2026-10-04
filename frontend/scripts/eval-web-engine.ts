// Evaluate the in-browser chord engine (the exact analysis core the Web Worker runs) on
// synthetic songs with known ground truth, rendered by backend/scripts/make_synthetic.py.
//
//   cd backend && uv run python scripts/make_synthetic.py --out /tmp/songs            # 8 fixed songs
//   cd backend && uv run python scripts/make_synthetic.py --out /tmp/rand --random 14 # held-out set
//   cd frontend && node scripts/eval-web-engine.ts --dir /tmp/songs [--dir /tmp/rand] [--only NAME...] [-v]
//        [--json out.json] [--params '{"changePenalty": 10}']   (overrides of AnalyzeParams for tuning)
//
// Metrics match backend/scripts/eval_engine.py: frame-level (100 Hz), duration weighted:
//   root    root pitch class (N must match N)
//   majmin  maj/min/N reduction; frames whose reference is sus/dim/aug are excluded (as mir_eval)
//   full    exact root + quality (bass ignored), all frames
//   label   exact label incl. slash bass
// plus key / time signature correctness, beat F-measure (+-70 ms), tempo and timing.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { analyzeSignal, type AnalyzeParams } from '../src/lib/engine/core/analyze.ts'
import { MAJMIN_OF, parseLabel, type Chord } from '../src/lib/engine/core/chords.ts'
import { resample } from '../src/lib/engine/core/resample.ts'
import { SR } from '../src/lib/engine/core/spectrum.ts'
import { readWav } from './wav.ts'

const RATE = 100

interface Truth {
  name?: string
  chords: { start: number; end: number; label: string }[]
  beats: number[]
  tempo: number
  timeSignature: number
  key: string
  duration: number
}

interface Row {
  name: string
  root: number
  majmin: number
  full: number
  label: number
  frames: number
  key: string
  keyOk: boolean
  ts: number
  tsOk: boolean
  beatF: number
  beatOffsetMs: number
  tempo: number
  refTempo: number
  seconds: number
  resampleSeconds: number
  duration: number
}

function sample(chords: { start: number; end: number; label: string }[], duration: number): (Chord | null)[] {
  const n = Math.ceil(duration * RATE)
  const out: (Chord | null)[] = new Array(n).fill(null)
  for (const c of chords) {
    const a = Math.max(0, Math.round(c.start * RATE))
    const b = Math.min(n, Math.round(c.end * RATE))
    const ch = parseLabel(c.label)
    for (let i = a; i < b; i++) out[i] = ch
  }
  return out
}

function majmin(c: Chord | null): string | null {
  if (c === null) return null
  if (c.root === null) return 'N'
  const red = MAJMIN_OF[c.quality ?? '']
  return red ? `${c.root}:${red}` : null
}

function score(est: { start: number; end: number; label: string }[], ref: Truth['chords'], duration: number) {
  const e = sample(est, duration)
  const r = sample(ref, duration)
  let root = 0
  let mm = 0
  let mmTotal = 0
  let full = 0
  let label = 0
  let total = 0
  for (let i = 0; i < Math.min(e.length, r.length); i++) {
    const ri = r[i]
    const ei = e[i]
    if (ri === null) continue
    total++
    if (ei === null) continue
    if (ri.root === ei.root) root++
    if (ri.root === ei.root && ri.quality === ei.quality) full++
    if (ri.root === ei.root && ri.quality === ei.quality && ri.bass === ei.bass) label++
    const rm = majmin(ri)
    if (rm !== null) {
      mmTotal++
      if (majmin(ei) === rm) mm++
    }
  }
  const t = Math.max(total, 1)
  return { root: root / t, majmin: mm / Math.max(mmTotal, 1), full: full / t, label: label / t, frames: total }
}

function beatF(est: number[], ref: number[], tol = 0.07): { f: number; offsetMs: number } {
  if (!est.length || !ref.length) return { f: 0, offsetMs: 0 }
  const used = new Uint8Array(est.length)
  let hits = 0
  let offset = 0
  for (const b of ref) {
    let j = -1
    let d = Infinity
    est.forEach((e, k) => {
      if (!used[k] && Math.abs(e - b) < d) {
        d = Math.abs(e - b)
        j = k
      }
    })
    if (j >= 0 && d <= tol) {
      used[j] = 1
      hits++
      offset += est[j] - b
    }
  }
  const p = hits / est.length
  const rc = hits / ref.length
  return { f: p + rc === 0 ? 0 : (2 * p * rc) / (p + rc), offsetMs: hits ? (1000 * offset) / hits : 0 }
}

function parseArgs(argv: string[]) {
  const dirs: string[] = []
  const only: string[] = []
  let verbose = false
  let json: string | null = null
  let params: Partial<AnalyzeParams> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') dirs.push(argv[++i])
    else if (a === '--only') while (argv[i + 1] && !argv[i + 1].startsWith('-')) only.push(argv[++i])
    else if (a === '-v' || a === '--verbose') verbose = true
    else if (a === '--json') json = argv[++i]
    else if (a === '--params') params = JSON.parse(argv[++i]) as Partial<AnalyzeParams>
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/eval-web-engine.ts --dir DIR [--dir DIR2] [--only NAME...] [-v] [--json OUT] [--params JSON]')
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!dirs.length) throw new Error('pass at least one --dir with <name>.wav + <name>.json files')
  return { dirs, only, verbose, json, params }
}

const pad = (s: string | number, n: number) => String(s).padStart(n)

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const rows: Row[] = []
  for (const dir of args.dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const truth = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Truth
      const name = truth.name ?? file.replace(/\.json$/, '')
      if (args.only.length && !args.only.includes(name)) continue
      const wav = readWav(readFileSync(join(dir, file.replace(/\.json$/, '.wav'))))
      const t0 = performance.now()
      const y = resample(wav.samples, wav.sampleRate, SR)
      const t1 = performance.now()
      const res = analyzeSignal(y, SR, { duration: wav.samples.length / wav.sampleRate, params: args.params })
      const t2 = performance.now()
      const sc = score(res.chords, truth.chords, truth.duration)
      const bf = beatF(res.beats, truth.beats)
      rows.push({
        name, ...sc,
        key: res.key.name, keyOk: res.key.name === truth.key,
        ts: res.timeSignature, tsOk: res.timeSignature === truth.timeSignature,
        beatF: bf.f, beatOffsetMs: bf.offsetMs, tempo: res.tempo, refTempo: truth.tempo,
        seconds: (t2 - t1) / 1000, resampleSeconds: (t1 - t0) / 1000, duration: truth.duration,
      })
      if (args.verbose) {
        console.log(`--- ${name}`)
        console.log('  est:', res.chords.map((c) => `${c.label}@${c.start.toFixed(1)}`).join(' '))
        console.log('  ref:', truth.chords.map((c) => `${c.label}@${c.start.toFixed(1)}`).join(' '))
      }
    }
  }
  if (!rows.length) {
    console.log('no songs evaluated')
    return
  }
  const hdr = `${'song'.padEnd(22)} ${pad('root', 6)} ${pad('majmin', 7)} ${pad('full', 6)} ${pad('label', 6)} `
    + `${pad('key', 8)} ${pad('ts', 4)} ${pad('beatF', 6)} ${pad('offs', 5)} ${pad('bpm', 6)} ${pad('ref', 5)} ${pad('sec', 6)}`
  console.log(hdr)
  console.log('-'.repeat(hdr.length))
  for (const r of rows) {
    console.log(`${r.name.padEnd(22)} ${pad(r.root.toFixed(3), 6)} ${pad(r.majmin.toFixed(3), 7)} `
      + `${pad(r.full.toFixed(3), 6)} ${pad(r.label.toFixed(3), 6)} ${pad(r.key + (r.keyOk ? '' : '*'), 8)} `
      + `${pad(r.ts + (r.tsOk ? '' : '*'), 4)} ${pad(r.beatF.toFixed(3), 6)} ${pad(Math.round(r.beatOffsetMs), 5)} `
      + `${pad(r.tempo.toFixed(1), 6)} ${pad(r.refTempo, 5)} ${pad(r.seconds.toFixed(2), 6)}`)
  }
  const w = rows.map((r) => r.frames)
  const wsum = w.reduce((a, b) => a + b, 0)
  const avg = (k: 'root' | 'majmin' | 'full' | 'label' | 'beatF') => rows.reduce((s, r, i) => s + w[i] * r[k], 0) / wsum
  console.log('-'.repeat(hdr.length))
  console.log(`${'WEIGHTED MEAN'.padEnd(22)} ${pad(avg('root').toFixed(3), 6)} ${pad(avg('majmin').toFixed(3), 7)} `
    + `${pad(avg('full').toFixed(3), 6)} ${pad(avg('label').toFixed(3), 6)} `
    + `${pad(`${rows.filter((r) => r.keyOk).length}/${rows.length}`, 8)} ${pad(`${rows.filter((r) => r.tsOk).length}/${rows.length}`, 4)} `
    + `${pad(avg('beatF').toFixed(3), 6)}`)
  const audio = rows.reduce((s, r) => s + r.duration, 0)
  const time = rows.reduce((s, r) => s + r.seconds, 0)
  const tempoOk = rows.filter((r) => Math.abs(r.tempo / r.refTempo - 1) < 0.04).length
  console.log(`tempo within 4%: ${tempoOk}/${rows.length}; analyzed ${audio.toFixed(1)}s of audio in ${time.toFixed(2)}s `
    + `(${(audio / Math.max(time, 1e-9)).toFixed(1)}x realtime, excluding the ${rows.reduce((s, r) => s + r.resampleSeconds, 0).toFixed(2)}s `
    + 'spent resampling 44.1 kHz WAVs, which the browser does while decoding)')
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ rows, mean: { root: avg('root'), majmin: avg('majmin'), full: avg('full'), label: avg('label'), beatF: avg('beatF') } }, null, 1))
  }
}

main()
