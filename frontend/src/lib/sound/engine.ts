// The chord-sound engine: one lazily created AudioContext ("interactive" latency) shared by every
// chord / note preview, separate from the metronome's. Graph:
//
//   voice → (panner) → instrument bus ─┬──────────────────────────→ master (chordSoundVolume)
//                                      └→ send → room reverb ──────→ master → limiter → speakers
//
// A new chord fades the previous one out over 70 ms; finished voices are disconnected; the context
// is suspended after a few idle seconds, so nothing runs while nothing sounds. Every note is also
// published on the live-notes bus (src/lib/liveNotes.ts) with the performance.now() times it is
// heard, and recorded for the diagrams (./sounding.ts).

import { useApp, type Instrument } from '../../store'
import { emitLiveNotes, type LiveNote } from '../liveNotes'
import type { NoteEvent } from './chordNotes'
import { clamp, mulberry32 } from './dsp'
import { startHandpanNote } from './handpanTone'
import { startHarmoniumNote } from './harmonium'
import { startPianoNote } from './piano'
import { pluckParams, pluckRelease, renderPluck, type PluckInstrument } from './pluck'
import { roomImpulse } from './reverb'
import { addSounding, clearSounding, touchSounding, type SoundingNote } from './sounding'
import { COMPRESSOR_DELAY, contextToPerformance, outputStamp, timeRef, type TimeRef } from './time'
import type { VoiceParts } from './voice'

export type PlayKind = 'chord' | 'note'

export interface PlayRequest {
  instrument: Instrument
  /** a chord replaces everything sounding; a single note only replaces a chord or the same note */
  kind: PlayKind
  /** chord label the notes belong to (its diagrams light up) */
  label: string
  notes: readonly NoteEvent[]
}

/**
 * Notes start this long after currentTime (s): currentTime only advances once per audio callback
 * (up to ~12 ms), so a shorter lead could land in the past and start late.
 */
const LEAD = 0.025
/** Fade of the voices a new chord replaces (s). */
const FADE = 0.07
/**
 * The context is suspended after this long without sound (ms): nothing runs while idle, yet
 * someone going through the chords one by one does not pay the ~50–100 ms restart each time.
 */
const IDLE_MS = 15000
/** How long the keys (piano, harmonium) stay down before the dampers fall / the reeds stop (s). */
const KEY_HOLD: Record<PlayKind, number> = { chord: 2.6, note: 1.6 }
/**
 * Per-instrument bus level and reverb send. Levels are matched by ear-proxy: every instrument's
 * chord measures about −16 dBFS RMS over its first 300 ms at full volume (peaks ≤ −4 dBFS through
 * the limiter; check with window.__chordSound.renderOffline in dev).
 */
const BUS: Record<Instrument, { level: number; reverb: number }> = {
  piano: { level: 1.6, reverb: 0.16 },
  harmonium: { level: 1.44, reverb: 0.2 },
  guitar: { level: 1.3, reverb: 0.12 },
  bass: { level: 1.46, reverb: 0.06 },
  ukulele: { level: 1.45, reverb: 0.12 },
  handpan: { level: 0.7, reverb: 0.24 },
}
/** Per-string level of the cached plucks (they are RMS-normalized). */
const PLUCK_LEVEL = 0.55
const PLUCK_CACHE_MAX = 48

/** Perceptual volume curve of the chordSoundVolume setting (0..1). */
export function volumeGain(volume: number): number {
  const v = clamp(Number.isFinite(volume) ? volume : 0.8, 0, 1)
  return v * v
}

type Ctor = typeof AudioContext

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ?? null
}

interface Graph {
  ctx: BaseAudioContext
  master: GainNode
  reverb: ConvolverNode | null
  buses: Partial<Record<Instrument, GainNode>>
  noise: AudioBuffer | null
}

/** Master → limiter → destination, the room, and a shared noise buffer (hammer / hand attacks). */
function buildGraph(ctx: BaseAudioContext, volume: number): Graph {
  const master = ctx.createGain()
  master.gain.value = volumeGain(volume)
  // Gentle limiter: chords stay clean when they stack up at high volume.
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -6
  limiter.knee.value = 6
  limiter.ratio.value = 12
  limiter.attack.value = 0.002
  limiter.release.value = 0.15
  master.connect(limiter)
  limiter.connect(ctx.destination)

  let reverb: ConvolverNode | null = null
  try {
    const [left, right] = roomImpulse(ctx.sampleRate)
    const ir = ctx.createBuffer(2, left.length, ctx.sampleRate)
    ir.getChannelData(0).set(left)
    ir.getChannelData(1).set(right)
    reverb = ctx.createConvolver()
    reverb.normalize = false
    reverb.buffer = ir
    reverb.connect(master)
  } catch {
    reverb = null
  }

  let noise: AudioBuffer | null = null
  try {
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.5), ctx.sampleRate)
    const data = noise.getChannelData(0)
    const rand = mulberry32(42)
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1
  } catch {
    noise = null
  }
  return { ctx, master, reverb, buses: {}, noise }
}

function busFor(g: Graph, instrument: Instrument): GainNode {
  const have = g.buses[instrument]
  if (have) return have
  const bus = g.ctx.createGain()
  bus.gain.value = BUS[instrument].level
  bus.connect(g.master)
  if (g.reverb) {
    const send = g.ctx.createGain()
    send.gain.value = BUS[instrument].reverb
    bus.connect(send)
    send.connect(g.reverb)
  }
  g.buses[instrument] = bus
  return bus
}

// Plucked strings are rendered once per (instrument, pitch, sample rate); least recently used dropped.
const pluckCache = new Map<string, AudioBuffer>()

function pluckBuffer(ctx: BaseAudioContext, instrument: PluckInstrument, midi: number): { buffer: AudioBuffer; release: number } {
  const params = pluckParams(instrument, midi, ctx.sampleRate)
  const key = `${instrument}:${midi}:${ctx.sampleRate}`
  let buffer = pluckCache.get(key)
  if (buffer) pluckCache.delete(key)
  else {
    const data = renderPluck(params)
    buffer = ctx.createBuffer(1, data.length, ctx.sampleRate)
    buffer.getChannelData(0).set(data)
    while (pluckCache.size >= PLUCK_CACHE_MAX) pluckCache.delete(pluckCache.keys().next().value as string)
  }
  pluckCache.set(key, buffer)
  return { buffer, release: pluckRelease(params) }
}

function startPluckNote(ctx: BaseAudioContext, when: number, instrument: PluckInstrument, midi: number, velocity: number): VoiceParts {
  const { buffer, release } = pluckBuffer(ctx, instrument, midi)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const level = PLUCK_LEVEL * Math.pow(clamp(velocity, 0.05, 1), 1.3)
  const out = ctx.createGain()
  out.gain.value = level
  src.connect(out)
  src.start(when)
  return { out, level, sources: [src], nodes: [src, out], end: when + buffer.duration, release }
}

function startVoice(g: Graph, instrument: Instrument, kind: PlayKind, n: NoteEvent, when: number): VoiceParts {
  switch (instrument) {
    case 'piano':
      return startPianoNote(g.ctx, when, n.midi, n.velocity, KEY_HOLD[kind], g.noise)
    case 'harmonium':
      return startHarmoniumNote(g.ctx, when, n.midi, n.velocity, KEY_HOLD[kind])
    case 'handpan':
      return startHandpanNote(g.ctx, when, n.midi, n.velocity, g.noise)
    default:
      return startPluckNote(g.ctx, when, instrument, n.midi, n.velocity)
  }
}

/** Keyboards spread by pitch (low left, high right, gently; the harmonium narrower); the others pass their own `pan`. */
function panOf(instrument: Instrument, n: NoteEvent): number {
  if (n.pan != null) return n.pan
  const spread = instrument === 'piano' ? 0.35 : instrument === 'harmonium' ? 0.2 : 0
  return clamp((n.midi - 60) / 26, -1, 1) * spread
}

/** Connects a voice to the bus through a stereo panner (when the browser has one). */
function route(g: Graph, parts: VoiceParts, pan: number, bus: AudioNode): AudioNode | null {
  if (pan !== 0 && typeof g.ctx.createStereoPanner === 'function') {
    const panner = g.ctx.createStereoPanner()
    panner.pan.value = clamp(pan, -1, 1)
    parts.out.connect(panner)
    panner.connect(bus)
    return panner
  }
  parts.out.connect(bus)
  return null
}

interface Voice {
  parts: VoiceParts
  panner: AudioNode | null
  kind: PlayKind
  instrument: Instrument
  midi: number
  /** the recorded note (shared with ./sounding.ts; its `end` is shortened when the voice is cut) */
  note: SoundingNote
  cut: boolean
}

function dispose(v: Voice): void {
  for (const n of v.parts.nodes) {
    try {
      n.disconnect()
    } catch {
      // already disconnected
    }
  }
  try {
    v.panner?.disconnect()
  } catch {
    // already disconnected
  }
}

const liveNote = (n: SoundingNote): LiveNote => ({ midi: n.midi, start: n.start, end: n.end, velocity: n.velocity })

export interface SoundStats {
  /** chords / notes scheduled so far */
  plays: number
  /** voices scheduled so far */
  voices: number
  /** voices currently alive (scheduled or sounding) */
  active: number
  /** the live notes of the last play, as emitted */
  last: LiveNote[]
  /** AudioContext start time of each of those notes (s) */
  lastContextTimes: number[]
  state: AudioContextState | 'none'
}

class SoundEngine {
  private graph: Graph | null = null
  private failed = false
  private voices: Voice[] = []
  private sweepTimer = 0
  private idleTimer = 0
  private playId = 0
  private chordTicket = 0
  private plays = 0
  private scheduled = 0
  private last: LiveNote[] = []
  private lastTimes: number[] = []
  /** performance.now() when the context last (re)started running */
  private runningSince = 0
  /** the browser's output timestamp proved usable (false: it never went live, ignore it) */
  private stampOk: boolean | null = null

  /** Web Audio exists in this browser (no context is created). */
  get supported(): boolean {
    return !this.failed && audioContextCtor() != null
  }

  /** Counters for development / diagnostics (window.__chordSound in dev builds). */
  get stats(): SoundStats {
    return {
      plays: this.plays,
      voices: this.scheduled,
      active: this.voices.length,
      last: this.last,
      lastContextTimes: this.lastTimes,
      state: this.graph ? (this.graph.ctx as AudioContext).state : 'none',
    }
  }

  /**
   * Creates the context on first use and resumes it. Call synchronously inside the user gesture
   * (click / key press): that is what browsers require before audio may start. Null without Web Audio.
   */
  unlock(): Graph | null {
    const g = this.ensureGraph()
    if (!g) return null
    const ctx = g.ctx as AudioContext
    if (ctx.state !== 'running') {
      try {
        void ctx.resume().catch(() => undefined)
      } catch {
        // resume unsupported / refused: play() gives up quietly
      }
      // iOS: starting a (silent) buffer inside the gesture unlocks the audio session
      try {
        const src = ctx.createBufferSource()
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
        src.connect(ctx.destination)
        src.onended = () => src.disconnect()
        src.start(0)
      } catch {
        // ignore
      }
    }
    window.clearTimeout(this.idleTimer)
    if (!this.voices.length) this.scheduleIdle()
    return g
  }

  /** Plays a chord / note as soon as the context runs. Resolves false when nothing was scheduled. */
  async play(req: PlayRequest): Promise<boolean> {
    if (!req.notes.length) return false
    const g = this.unlock()
    if (!g) return false
    const ticket = req.kind === 'chord' ? ++this.chordTicket : this.chordTicket
    const ctx = g.ctx as AudioContext
    if (ctx.state !== 'running' && !(await this.whenRunning(ctx))) return false
    await this.settle(ctx)
    // a newer chord was requested while the context was starting
    if (req.kind === 'chord' && ticket !== this.chordTicket) return false
    this.schedule(g, req)
    return true
  }

  /** Fades out everything (e.g. the track was closed). */
  stopAll(): void {
    const g = this.graph
    if (!g || !this.voices.length) return
    const at = g.ctx.currentTime
    const ref = this.timeRef(g.ctx as AudioContext)
    this.cutVoices(this.voices, at, (t) => contextToPerformance(t, ref))
    this.scheduleSweep()
  }

  private ensureGraph(): Graph | null {
    if (this.graph) return this.graph
    if (this.failed) return null
    const C = audioContextCtor()
    if (!C) {
      this.failed = true
      return null
    }
    try {
      let ctx: AudioContext
      try {
        ctx = new C({ latencyHint: 'interactive' })
      } catch {
        ctx = new C()
      }
      this.graph = buildGraph(ctx, useApp.getState().chordSoundVolume)
      this.runningSince = performance.now()
      useApp.subscribe((s, p) => {
        if (s.chordSoundVolume !== p.chordSoundVolume) this.setVolume(s.chordSoundVolume)
      })
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') this.runningSince = performance.now()
        else this.sweep()
      })
      return this.graph
    } catch {
      this.failed = true
      return null
    }
  }

  private setVolume(volume: number): void {
    const g = this.graph
    if (!g) return
    try {
      g.master.gain.setTargetAtTime(volumeGain(volume), g.ctx.currentTime, 0.015)
    } catch {
      g.master.gain.value = volumeGain(volume)
    }
  }

  private whenRunning(ctx: AudioContext): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        ctx.removeEventListener('statechange', check)
        resolve(ok)
      }
      const check = () => {
        if (ctx.state === 'running') finish(true)
      }
      const timer = window.setTimeout(() => finish(ctx.state === 'running'), 1500)
      ctx.addEventListener('statechange', check)
      ctx.resume().then(check, () => finish(false))
    })
  }

  /** Context time → performance.now() mapping, ignoring output timestamps from before the last (re)start. */
  private timeRef(ctx: AudioContext): TimeRef {
    return timeRef(ctx, performance.now(), COMPRESSOR_DELAY, this.stampOk === false ? Infinity : this.runningSince)
  }

  /**
   * Whether the audio clock maps to real time: a live output timestamp rendered after the last
   * (re)start or, in browsers without a usable one, ~60 ms of running.
   */
  private clockLive(ctx: AudioContext): boolean {
    const now = performance.now()
    if (this.stampOk !== false && typeof ctx.getOutputTimestamp === 'function') {
      const live = outputStamp(ctx, now, this.runningSince) != null
      if (live) this.stampOk = true
      return live
    }
    return now - this.runningSince >= 60
  }

  /**
   * Right after the context starts or resumes, its clock does not map to real time yet (Chrome:
   * currentTime stalls and the output timestamp is empty or stale for ~50 ms). Waits until it does,
   * so the live notes' times are exact. Instant in the steady state; never longer than 250 ms (a
   * browser whose timestamp never goes live is not waited for again).
   */
  private settle(ctx: AudioContext): Promise<void> {
    if (this.clockLive(ctx)) return Promise.resolve()
    const begin = performance.now()
    return new Promise((resolve) => {
      const poll = () => {
        if (this.clockLive(ctx) || ctx.state !== 'running') resolve()
        else if (performance.now() - begin > 250) {
          if (this.stampOk !== true) this.stampOk = false
          resolve()
        } else window.setTimeout(poll, 8)
      }
      window.setTimeout(poll, 4)
    })
  }

  private schedule(g: Graph, req: PlayRequest): void {
    const ctx = g.ctx as AudioContext
    const t0 = ctx.currentTime + LEAD
    const ref = this.timeRef(ctx)
    const toPerf = (t: number) => contextToPerformance(t, ref)
    const midis = new Set(req.notes.map((n) => n.midi))
    this.cutVoices(
      this.voices.filter(
        (v) => req.kind === 'chord' || v.kind === 'chord' || (v.instrument === req.instrument && midis.has(v.midi)),
      ),
      t0,
      toPerf,
    )
    const bus = busFor(g, req.instrument)
    const id = ++this.playId
    const played: SoundingNote[] = []
    const times: number[] = []
    for (const n of req.notes) {
      const when = t0 + Math.max(0, n.offset)
      let parts: VoiceParts
      try {
        parts = startVoice(g, req.instrument, req.kind, n, when)
      } catch {
        continue
      }
      const panner = route(g, parts, panOf(req.instrument, n), bus)
      const note: SoundingNote = {
        midi: n.midi,
        start: toPerf(when),
        end: toPerf(when + parts.release),
        velocity: n.velocity,
        target: n.target,
      }
      this.voices.push({ parts, panner, kind: req.kind, instrument: req.instrument, midi: n.midi, note, cut: false })
      played.push(note)
      times.push(when)
    }
    if (!played.length) return
    this.plays++
    this.scheduled += played.length
    this.last = played.map(liveNote)
    this.lastTimes = times
    emitLiveNotes(this.last)
    addSounding({ id, instrument: req.instrument, label: req.label, notes: played })
    this.scheduleSweep()
  }

  /**
   * Fades `voices` out from context time `at` and stops their sources. Their live notes are
   * re-emitted with the same midi + start and the earlier `end` (notes scheduled after `at` end
   * where they start, i.e. never sound).
   */
  private cutVoices(voices: Voice[], at: number, toPerf: (t: number) => number): void {
    const changed: SoundingNote[] = []
    for (const v of voices) {
      if (v.cut || v.parts.end <= at) continue
      v.cut = true
      const gain = v.parts.out.gain
      try {
        gain.cancelScheduledValues(at)
        gain.setValueAtTime(v.parts.level, at)
        gain.linearRampToValueAtTime(0, at + FADE)
      } catch {
        // the stop below still ends it
      }
      for (const s of v.parts.sources) {
        try {
          s.stop(at + FADE + 0.005)
        } catch {
          // older Safari: a second stop() throws; the fade has silenced it anyway
        }
      }
      v.parts.end = Math.min(v.parts.end, at + FADE + 0.005)
      const end = Math.max(v.note.start, toPerf(at))
      if (end < v.note.end) {
        v.note.end = end
        changed.push(v.note)
      }
    }
    if (changed.length) {
      emitLiveNotes(changed.map(liveNote))
      touchSounding()
    }
  }

  private scheduleSweep(): void {
    window.clearTimeout(this.sweepTimer)
    const g = this.graph
    if (!g) return
    if (!this.voices.length) {
      this.scheduleIdle()
      return
    }
    let next = Infinity
    for (const v of this.voices) next = Math.min(next, v.parts.end)
    const ms = Math.max(50, (next - g.ctx.currentTime) * 1000 + 60)
    this.sweepTimer = window.setTimeout(() => this.sweep(), ms)
  }

  /** Disconnects finished voices (all of them when the context stopped running). */
  private sweep(): void {
    const g = this.graph
    if (!g) return
    const running = (g.ctx as AudioContext).state === 'running'
    const now = g.ctx.currentTime
    const keep: Voice[] = []
    for (const v of this.voices) {
      if (!running || v.parts.end <= now + 0.01) dispose(v)
      else keep.push(v)
    }
    this.voices = keep
    if (!running) clearSounding()
    this.scheduleSweep()
  }

  private scheduleIdle(): void {
    window.clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => {
      const ctx = this.graph?.ctx as AudioContext | undefined
      if (!ctx || this.voices.length || ctx.state !== 'running') return
      void ctx.suspend().catch(() => undefined)
    }, IDLE_MS)
  }
}

export const soundEngine = new SoundEngine()

/**
 * Renders a request offline through the same graph (for checks in the browser console / tests that
 * have an OfflineAudioContext). Resolves the stereo buffer.
 */
export async function renderOffline(req: PlayRequest, seconds = 4, sampleRate = 48000, volume = 1): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * sampleRate), sampleRate)
  const g = buildGraph(ctx, volume)
  const bus = busFor(g, req.instrument)
  for (const n of req.notes) {
    const parts = startVoice(g, req.instrument, req.kind, n, 0.01 + n.offset)
    route(g, parts, panOf(req.instrument, n), bus)
  }
  return ctx.startRendering()
}
