// The chord-sound engine: one lazily created AudioContext ("interactive" latency) shared by every
// chord / note preview, separate from the metronome's. Graph:
//
//   voice → (panner) → volume ─→ instrument bus ─┬───────────────────────→ master
//                                                 └→ send → room reverb ──→ master → limiter → speakers
//
// The volume stage is per group and instrument: the chord sound (clicks, the drone) follows the
// chordSoundVolume setting, the play-along its own playAlongVolume.
//
// A new chord fades the previous one out over 70 ms; finished voices are disconnected; the context
// is suspended after a few idle seconds, so nothing runs while nothing sounds. Every note is also
// published on the live-notes bus (src/lib/liveNotes.ts) with the performance.now() times it is
// heard, and recorded for the diagrams (./sounding.ts).

import { useApp, type Instrument } from '../../store'
import { emitLiveNotes, type LiveNote } from '../liveNotes'
import type { NoteEvent } from './chordNotes'
import { clamp } from './dsp'
import { handpanParams, handpanRelease, renderHandpan } from './handpanTone'
import { DRONE_HOLD, DRONE_LOOP_START, droneLoop } from './drone'
import { harmoniumParams, renderHarmonium } from './harmonium'
import { pianoParams, renderPiano } from './piano'
import { pluckParams, pluckRelease, renderPluck, type PluckInstrument } from './pluck'
import { roomImpulse } from './reverb'
import { renderWind, windLoop, windParams } from './wind'
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
  handpan: { level: 1.4, reverb: 0.24 },
  // one note at a time, held: a sustained note measures ~−17 dBFS RMS, its first 300 ms ~−19.5
  sopilka: { level: 1.1, reverb: 0.2 },
  flute: { level: 1.1, reverb: 0.22 },
}
/** Per-string level of the cached plucks (they are RMS-normalized). */
const PLUCK_LEVEL = 0.55
/** Per-key level of the cached harmonium notes (rendered at HARMONIUM_RMS); touch barely matters. */
const HARMONIUM_LEVEL = 0.44
/** Per-key level of the cached piano notes (rendered at PIANO_RMS; the touch's loudness is in the buffer). */
const PIANO_LEVEL = 0.75
/** Per-note level of the cached handpan notes (rendered at HANDPAN_RMS; the strike's force scales it). */
const HANDPAN_LEVEL = 0.77
/** Per-note level of the cached wind notes (rendered at WIND_RMS; one note at a time, so louder than a chord's keys). */
const WIND_LEVEL = 0.9
/** How long a wind note is blown when nothing says (s): a clicked note. */
const WIND_HOLD: Record<PlayKind, number> = { chord: 1.2, note: 1.1 }
/** The player stops blowing: the tone dies away in this long (s; a tongue stop is quicker, a breath release slower). */
export const WIND_RELEASE = 0.06
/** The harmonium's drone: as loud as one key of a chord, and how fast it swells in / dies away (s). */
const DRONE_LEVEL = HARMONIUM_LEVEL
const DRONE_SWELL = 0.25
const DRONE_FADE = 0.2
/** How fast a held harmonium key's reeds stop when it comes up (s), like the rendered notes' release. */
const HELD_RELEASE = 0.03
/** Piano notes are rendered at touches this far apart (≤ 0.1 dB off; the cache stays small). */
const PIANO_TOUCH_STEP = 0.02
const BUFFER_CACHE_MAX = 48

/** Perceptual volume curve of the chordSoundVolume setting (0..1). */
export function volumeGain(volume: number): number {
  const v = clamp(Number.isFinite(volume) ? volume : 0.8, 0, 1)
  return v * v
}

/** Highest play-along volume setting (2 = 200%): over a loud recording the accompaniment may need more. */
export const PLAY_ALONG_MAX_VOLUME = 2

/** The play-along volume's curve: perceptual up to 100%, then steeper (the limiter keeps it clean), like the metronome's. */
export function alongVolumeGain(volume: number): number {
  const v = clamp(Number.isFinite(volume) ? volume : 0.8, 0, PLAY_ALONG_MAX_VOLUME)
  return v <= 1 ? v * v : 1 + (v - 1) * 3
}

/** What a voice belongs to, for its volume: a clicked chord / key / the drone, or the play-along. */
export type SoundGroup = 'click' | 'along'

const groupGain = (group: SoundGroup, volume: number) => (group === 'along' ? alongVolumeGain(volume) : volumeGain(volume))

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
  /** each group's gain now, and its volume stage per instrument (in front of the bus) */
  levels: Record<SoundGroup, number>
  inputs: Record<SoundGroup, Partial<Record<Instrument, GainNode>>>
}

/** Master → limiter → destination, and the room; `volumes` = the groups' volume settings. */
function buildGraph(ctx: BaseAudioContext, volumes: Record<SoundGroup, number>): Graph {
  const master = ctx.createGain()
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
  return {
    ctx,
    master,
    reverb,
    buses: {},
    levels: { click: groupGain('click', volumes.click), along: groupGain('along', volumes.along) },
    inputs: { click: {}, along: {} },
  }
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

/** Where a voice of `group` on `instrument` connects: the group's volume, then the instrument's bus. */
function inputFor(g: Graph, group: SoundGroup, instrument: Instrument): GainNode {
  const have = g.inputs[group][instrument]
  if (have) return have
  const input = g.ctx.createGain()
  input.gain.value = g.levels[group]
  input.connect(busFor(g, instrument))
  g.inputs[group][instrument] = input
  return input
}

// Plucked strings (per instrument, pitch, sample rate), harmonium keys (per pitch, hold, sample rate),
// piano keys (per pitch, touch, hold, sample rate), handpan notes (per pitch, ding or field, sample
// rate) and wind notes (per instrument, pitch, sample rate: any hold loops the same buffer) are
// rendered once; least recently used dropped.
const bufferCache = new Map<string, AudioBuffer>()

function cachedBuffer(ctx: BaseAudioContext, key: string, render: () => Float32Array): AudioBuffer {
  let buffer = bufferCache.get(key)
  if (buffer) bufferCache.delete(key)
  else {
    const data = render()
    buffer = ctx.createBuffer(1, data.length, ctx.sampleRate)
    buffer.getChannelData(0).set(data)
    while (bufferCache.size >= BUFFER_CACHE_MAX) bufferCache.delete(bufferCache.keys().next().value as string)
  }
  bufferCache.set(key, buffer)
  return buffer
}

/** The rendered buffer a note plays from: its cache key, and how to render it. */
interface NoteSource {
  key: string
  render(): Float32Array
}

const pianoTouch = (velocity: number) => Math.round(clamp(velocity, 0, 1) / PIANO_TOUCH_STEP) * PIANO_TOUCH_STEP

/** Which buffer `n` sounds from on `instrument` (a held harmonium key: the drone's looped note). */
function noteSource(ctx: BaseAudioContext, instrument: Instrument, kind: PlayKind, n: NoteEvent): NoteSource {
  const sr = ctx.sampleRate
  const { midi } = n
  switch (instrument) {
    case 'piano': {
      const touch = pianoTouch(n.velocity)
      const hold = n.hold ?? KEY_HOLD[kind]
      return { key: `piano:${midi}:${touch.toFixed(2)}:${hold}:${sr}`, render: () => renderPiano(pianoParams(midi, touch, hold, sr)) }
    }
    case 'harmonium': {
      if (n.hold != null) return droneSource(midi, sr)
      const hold = KEY_HOLD[kind]
      return { key: `harmonium:${midi}:${hold}:${sr}`, render: () => renderHarmonium(harmoniumParams(midi, hold, sr)) }
    }
    case 'handpan': {
      const ding = n.target === 0
      return { key: `handpan:${midi}:${ding ? 'ding' : 'field'}:${sr}`, render: () => renderHandpan(handpanParams(midi, ding, sr)) }
    }
    case 'sopilka':
    case 'flute':
      return { key: `${instrument}:${midi}:${sr}`, render: () => renderWind(windParams(instrument, midi, sr)) }
    default:
      return { key: `${instrument}:${midi}:${sr}`, render: () => renderPluck(pluckParams(instrument, midi, sr)) }
  }
}

/** The harmonium key looped for as long as it is held (the drone, the play-along's held chords). */
function droneSource(midi: number, sr: number): NoteSource {
  return { key: `harmonium-drone:${midi}:${sr}`, render: () => droneLoop(renderHarmonium(harmoniumParams(midi, DRONE_HOLD, sr)), sr) }
}

const sourceBuffer = (ctx: BaseAudioContext, src: NoteSource) => cachedBuffer(ctx, src.key, () => src.render())

function startPluckNote(ctx: BaseAudioContext, when: number, instrument: PluckInstrument, n: NoteEvent, buffer: AudioBuffer): VoiceParts {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const level = PLUCK_LEVEL * Math.pow(clamp(n.velocity, 0.05, 1), 1.3)
  const out = ctx.createGain()
  out.gain.value = level
  src.connect(out)
  src.start(when)
  return { out, level, sources: [src], nodes: [src, out], end: when + buffer.duration, release: pluckRelease(pluckParams(instrument, n.midi, ctx.sampleRate)) }
}

/** A harmonium key held `hold` seconds: its rendered note (the release is in the buffer). */
function startHarmoniumNote(ctx: BaseAudioContext, when: number, n: NoteEvent, hold: number, buffer: AudioBuffer): VoiceParts {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const level = HARMONIUM_LEVEL * (0.85 + 0.15 * clamp(n.velocity, 0, 1))
  const out = ctx.createGain()
  out.gain.value = level
  src.connect(out)
  src.start(when)
  return { out, level, sources: [src], nodes: [src, out], end: when + buffer.duration, release: hold }
}

/**
 * A harmonium key held any length (`n.hold` s): the looped note, swelling from the reed's speech,
 * its reeds stopping in HELD_RELEASE when the key comes up.
 */
function startHeldHarmoniumNote(ctx: BaseAudioContext, when: number, n: NoteEvent, hold: number, buffer: AudioBuffer): VoiceParts {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  src.loopStart = Math.round(DRONE_LOOP_START * ctx.sampleRate) / ctx.sampleRate
  src.loopEnd = buffer.duration
  const level = HARMONIUM_LEVEL * (0.85 + 0.15 * clamp(n.velocity, 0, 1))
  const out = ctx.createGain()
  const up = when + hold
  const end = up + HELD_RELEASE + 0.005
  out.gain.value = level
  out.gain.setValueAtTime(level, up)
  out.gain.linearRampToValueAtTime(0, up + HELD_RELEASE)
  src.connect(out)
  src.start(when)
  src.stop(end)
  return { out, level, sources: [src], nodes: [src, out], end, release: hold, fadeFrom: up }
}

/** A piano key held `hold` seconds: its rendered note (the dampers and the key-up thud are in the buffer). */
function startPianoNote(ctx: BaseAudioContext, when: number, hold: number, buffer: AudioBuffer): VoiceParts {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const level = PIANO_LEVEL
  const out = ctx.createGain()
  out.gain.value = level
  src.connect(out)
  src.start(when)
  return { out, level, sources: [src], nodes: [src, out], end: when + buffer.duration, release: hold }
}

/** A handpan note — the ding or a tone field — struck with `velocity`: its rendered ring. */
function startHandpanNote(ctx: BaseAudioContext, when: number, n: NoteEvent, buffer: AudioBuffer): VoiceParts {
  const ding = n.target === 0
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const level = HANDPAN_LEVEL * Math.pow(clamp(n.velocity, 0.05, 1), 1.2)
  const out = ctx.createGain()
  out.gain.value = level
  src.connect(out)
  src.start(when)
  return { out, level, sources: [src], nodes: [src, out], end: when + buffer.duration, release: handpanRelease(n.midi, ding) }
}

/**
 * A wind note blown `hold` seconds: its rendered attack, then the steady loop repeated for as long as
 * the breath lasts, dying away over WIND_RELEASE when the player stops.
 */
function startWindNote(ctx: BaseAudioContext, when: number, n: NoteEvent, hold: number, buffer: AudioBuffer): VoiceParts {
  const loop = windLoop(n.midi, ctx.sampleRate)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  src.loopStart = loop.start / ctx.sampleRate
  src.loopEnd = buffer.duration
  const level = WIND_LEVEL * (0.8 + 0.2 * clamp(n.velocity, 0, 1))
  const out = ctx.createGain()
  const up = when + hold
  const end = up + WIND_RELEASE + 0.005
  out.gain.value = level
  out.gain.setValueAtTime(level, up)
  // breath off: a fast exponential-like fall, closed with a short ramp to silence
  out.gain.setTargetAtTime(0, up, WIND_RELEASE / 4)
  out.gain.setValueAtTime(level * Math.exp(-3.6), up + WIND_RELEASE * 0.9)
  out.gain.linearRampToValueAtTime(0, up + WIND_RELEASE)
  src.connect(out)
  src.start(when)
  src.stop(end)
  return { out, level, sources: [src], nodes: [src, out], end, release: hold, fadeFrom: up }
}

function startVoice(g: Graph, instrument: Instrument, kind: PlayKind, n: NoteEvent, when: number): VoiceParts {
  const buffer = sourceBuffer(g.ctx, noteSource(g.ctx, instrument, kind, n))
  switch (instrument) {
    case 'piano':
      return startPianoNote(g.ctx, when, n.hold ?? KEY_HOLD[kind], buffer)
    case 'harmonium':
      return n.hold != null ? startHeldHarmoniumNote(g.ctx, when, n, n.hold, buffer) : startHarmoniumNote(g.ctx, when, n, KEY_HOLD[kind], buffer)
    case 'handpan':
      return startHandpanNote(g.ctx, when, n, buffer)
    case 'sopilka':
    case 'flute':
      return startWindNote(g.ctx, when, n, n.hold ?? WIND_HOLD[kind], buffer)
    default:
      return startPluckNote(g.ctx, when, instrument, n, buffer)
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
  /** played along the song (lib/sound/accompanyRuntime.ts) */
  accomp: boolean
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
  /** MIDI note of the harmonium's drone while it sounds */
  drone: number | null
  /** play-along steps scheduled so far, and how many of them were already due (started late) */
  alongSteps: number
  alongLate: number
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
  /** the harmonium's drone, looping while the song plays (not a voice: chords never cut it) */
  private drone: { midi: number; src: AudioBufferSourceNode; out: GainNode } | null = null
  private droneTicket = 0
  private alongSteps = 0
  private alongLate = 0
  /** the play-along runs: the context is not suspended between its steps */
  private alongAwake = false

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
      drone: this.drone?.midi ?? null,
      alongSteps: this.alongSteps,
      alongLate: this.alongLate,
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

  /**
   * Holds the harmonium's drone on `midi` (looped, swelling in) until called with another key or
   * null (it fades out). Separate from the chords: a new chord never cuts it.
   */
  async setDrone(midi: number | null): Promise<void> {
    const ticket = ++this.droneTicket
    if (midi == null) {
      this.stopDrone()
      return
    }
    if (this.drone?.midi === midi) return
    const g = this.unlock()
    if (!g) return
    const ctx = g.ctx as AudioContext
    if (ctx.state !== 'running' && !(await this.whenRunning(ctx))) return
    if (ticket !== this.droneTicket) return
    this.stopDrone()
    try {
      const sr = ctx.sampleRate
      const buffer = sourceBuffer(ctx, droneSource(midi, sr))
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      src.loopStart = Math.round(DRONE_LOOP_START * sr) / sr
      src.loopEnd = buffer.length / sr
      const out = ctx.createGain()
      const at = ctx.currentTime + LEAD
      out.gain.setValueAtTime(0, at)
      out.gain.linearRampToValueAtTime(DRONE_LEVEL, at + DRONE_SWELL)
      src.connect(out)
      out.connect(inputFor(g, 'click', 'harmonium'))
      src.start(at)
      this.drone = { midi, src, out }
      window.clearTimeout(this.idleTimer)
    } catch {
      // no drone, nothing else affected
    }
  }

  private stopDrone(): void {
    const d = this.drone
    const g = this.graph
    this.drone = null
    if (!d || !g) return
    const at = g.ctx.currentTime
    try {
      d.out.gain.cancelScheduledValues(at)
      d.out.gain.setValueAtTime(d.out.gain.value, at)
      d.out.gain.linearRampToValueAtTime(0, at + DRONE_FADE)
      d.src.stop(at + DRONE_FADE + 0.01)
    } catch {
      // already stopped
    }
    d.src.onended = () => {
      d.src.disconnect()
      d.out.disconnect()
    }
    if (!this.voices.length) this.scheduleIdle()
  }

  /**
   * The audio clock, for scheduling ahead of it: `now` (currentTime: nothing can start earlier),
   * `heard` — the context time reaching the listener right now (the output timestamp, else
   * currentTime minus the reported latencies; the limiter's lookahead included), so a note scheduled
   * at `heard + x` is heard x seconds from now — and whether the context runs. Null before the
   * context exists.
   */
  clock(): { now: number; heard: number; running: boolean } | null {
    const g = this.graph
    if (!g) return null
    const ctx = g.ctx as AudioContext
    const ref = this.timeRef(ctx)
    const heard = ref.contextTime + (performance.now() - ref.performanceTime) / 1000
    return { now: ctx.currentTime, heard, running: ctx.state === 'running' }
  }

  /**
   * Schedules a play-along step at context time `when`. Its voices are the accompaniment's own: a
   * step cuts the accompaniment's earlier ones (`cut` "all") or only those on its notes ("same"),
   * never a chord clicked meanwhile (which, being a chord, cuts them). False when the context is not
   * running.
   */
  scheduleAt(step: { instrument: Instrument; label: string; cut: 'all' | 'same'; notes: readonly NoteEvent[] }, when: number): boolean {
    const g = this.graph
    if (!g || (g.ctx as AudioContext).state !== 'running' || !step.notes.length) return false
    const now = g.ctx.currentTime
    this.alongSteps++
    if (when < now) this.alongLate++
    const t0 = Math.max(when, now + 0.002)
    const midis = new Set(step.notes.map((n) => n.midi))
    const victims = this.voices.filter((v) => v.accomp && (step.cut === 'all' || v.instrument !== step.instrument || midis.has(v.midi)))
    this.startVoices(g, { instrument: step.instrument, kind: 'chord', label: step.label, notes: step.notes }, t0, victims, true)
    return true
  }

  /** While the play-along runs the context stays awake, even through a long stretch without chords. */
  keepAwake(on: boolean): void {
    this.alongAwake = on
    if (on) window.clearTimeout(this.idleTimer)
    else if (!this.voices.length && !this.drone) this.scheduleIdle()
  }

  /** Fades out the accompaniment, including steps scheduled but not heard yet (pause, seek, off). */
  cancelAccompaniment(): void {
    const g = this.graph
    const along = this.voices.filter((v) => v.accomp)
    if (!g || !along.length) return
    const ref = this.timeRef(g.ctx as AudioContext)
    this.cutVoices(along, g.ctx.currentTime, (t) => contextToPerformance(t, ref))
    this.scheduleSweep()
  }

  /**
   * Renders the first of `notes` whose buffer is not cached yet (play-along: done ahead, a note per
   * call, so nothing renders at the moment it is due). True when one was rendered.
   */
  prepare(instrument: Instrument, notes: readonly NoteEvent[]): boolean {
    const g = this.graph
    if (!g) return false
    for (const n of notes) {
      const src = noteSource(g.ctx, instrument, 'chord', n)
      if (bufferCache.has(src.key)) continue
      sourceBuffer(g.ctx, src)
      return true
    }
    return false
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
      const s0 = useApp.getState()
      this.graph = buildGraph(ctx, { click: s0.chordSoundVolume, along: s0.playAlongVolume })
      this.runningSince = performance.now()
      useApp.subscribe((s, p) => {
        if (s.chordSoundVolume !== p.chordSoundVolume) this.setVolume('click', s.chordSoundVolume)
        if (s.playAlongVolume !== p.playAlongVolume) this.setVolume('along', s.playAlongVolume)
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

  private setVolume(group: SoundGroup, volume: number): void {
    const g = this.graph
    if (!g) return
    const level = groupGain(group, volume)
    g.levels[group] = level
    for (const input of Object.values(g.inputs[group])) {
      try {
        input.gain.setTargetAtTime(level, g.ctx.currentTime, 0.015)
      } catch {
        input.gain.value = level
      }
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
    const midis = new Set(req.notes.map((n) => n.midi))
    const victims = this.voices.filter(
      (v) => req.kind === 'chord' || v.kind === 'chord' || (v.instrument === req.instrument && midis.has(v.midi)),
    )
    this.startVoices(g, req, t0, victims, false)
  }

  /** Cuts `victims` at `t0` and starts the request's notes from `t0` (their offsets after it). */
  private startVoices(g: Graph, req: PlayRequest, t0: number, victims: Voice[], accomp: boolean): void {
    const ctx = g.ctx as AudioContext
    const ref = this.timeRef(ctx)
    const toPerf = (t: number) => contextToPerformance(t, ref)
    this.cutVoices(victims, t0, toPerf)
    const bus = inputFor(g, accomp ? 'along' : 'click', req.instrument)
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
      this.voices.push({ parts, panner, kind: req.kind, instrument: req.instrument, midi: n.midi, note, cut: false, accomp })
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
      // already fading out on its own (the play-along's next note lands in the last one's release):
      // a cut would raise it back to full level for the fade
      if (v.parts.fadeFrom != null && at >= v.parts.fadeFrom) continue
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
      if (!ctx || this.voices.length || this.drone || this.alongAwake || ctx.state !== 'running') return
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
  const g = buildGraph(ctx, { click: volume, along: volume })
  const bus = inputFor(g, 'click', req.instrument)
  for (const n of req.notes) {
    const parts = startVoice(g, req.instrument, req.kind, n, 0.01 + n.offset)
    route(g, parts, panOf(req.instrument, n), bus)
  }
  return ctx.startRendering()
}
