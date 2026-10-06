// A live listening session on the main thread: wires the stream into an AudioContext, the
// capture AudioWorklet (ScriptProcessor fallback) and the analysis worker, records the stream,
// and turns the worker's updates into LiveUpdates for listeners.

import workletUrl from './capture.worklet.ts?worker&url'
import type { AnalyzerChord } from './core/analyzer.ts'
import { WORKLET_BATCH, WORKLET_NAME, type FromWorker, type ToWorker, type ToWorklet, type WorkerUpdate } from './protocol.ts'
import { createRecording, type Recording } from './recorder.ts'
import {
  CaptureError, type LiveChord, type LiveOptions, type LiveResult, type LiveSession, type LiveSessionState, type LiveUpdate,
} from './types.ts'

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

function audioContextCtor(): AudioContextCtor | undefined {
  return globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
}

/** Can a live session run here (Web Audio + module workers)? */
export function isLiveSupported(): boolean {
  return typeof Worker !== 'undefined' && !!audioContextCtor()
}

const RESULT_TIMEOUT_MS = 5000
/** without an answer to the worklet's end marker, ask the worker directly */
const FINISH_NUDGE_MS = 400

function toLive(c: AnalyzerChord): LiveChord {
  return { start: c.start, end: c.end, label: c.label, confidence: c.confidence, provisional: c.provisional }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      },
    )
  })
}

interface Graph {
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode | ScriptProcessorNode
  worklet: boolean
  /** ScriptProcessor fallback: gate for pause */
  gate: { paused: boolean }
}

class Session implements LiveSession {
  private stateValue: LiveSessionState
  private readonly listeners = new Set<(u: LiveUpdate) => void>()
  private latest: LiveUpdate | null = null
  private finals: LiveChord[] = []
  private open: LiveChord[] = []
  private ended = false
  private error: string | undefined
  private stopping: Promise<LiveResult> | null = null
  private resultWaiter: ((r: { chords: AnalyzerChord[]; duration: number } | null) => void) | null = null
  private readonly cleanupTrackListeners: () => void
  private cleanupUnlock: (() => void) | null = null
  private readonly stream: MediaStream
  private readonly graph: Graph
  private readonly worker: Worker
  private readonly recording: Recording | null
  private readonly options: LiveOptions

  constructor(stream: MediaStream, graph: Graph, worker: Worker, recording: Recording | null, options: LiveOptions) {
    this.stream = stream
    this.graph = graph
    this.worker = worker
    this.recording = recording
    this.options = options
    this.stateValue = options.paused ? 'paused' : 'running'
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data)
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault()
      this.onWorker({ type: 'error', message: e.message || 'the live analysis worker crashed' })
    }
    worker.onmessageerror = () => this.onWorker({ type: 'error', message: 'unreadable message from the live analysis worker' })
    // the input ends when the user clicks "Stop sharing" or unplugs the microphone
    const tracks = stream.getAudioTracks()
    const onEnded = () => {
      if (tracks.every((t) => t.readyState === 'ended') && !this.ended) {
        this.ended = true
        // the recorder stops by itself; freeze the analysis too so session time matches the recording
        this.toWorklet({ type: 'pause' })
        this.toWorker({ type: 'pause' })
        this.emit({ ...this.snapshot(), level: 0 })
      }
    }
    tracks.forEach((t) => t.addEventListener('ended', onEnded))
    this.cleanupTrackListeners = () => tracks.forEach((t) => t.removeEventListener('ended', onEnded))
    // Safari "interrupted" / unexpected suspension while running: try to continue
    graph.ctx.onstatechange = () => {
      if (graph.ctx.state === 'running') this.cleanupUnlock?.()
      else if (this.stateValue === 'running' && graph.ctx.state !== 'closed') {
        graph.ctx.resume().catch(() => undefined)
        this.unlockOnGesture()
      }
    }
    if (graph.ctx.state !== 'running') this.unlockOnGesture()
    this.emit(this.snapshot())
  }

  /**
   * Without a user activation left (e.g. iOS after the permission prompt) the context can stay
   * suspended: resume it on the next tap / key press anywhere on the page.
   */
  private unlockOnGesture(): void {
    if (this.cleanupUnlock || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const ctx = this.graph.ctx
    const unlock = () => {
      if (ctx.state !== 'closed') ctx.resume().catch(() => undefined)
    }
    const events = ['pointerdown', 'keydown', 'touchend'] as const
    for (const e of events) window.addEventListener(e, unlock, { capture: true, passive: true })
    this.cleanupUnlock = () => {
      for (const e of events) window.removeEventListener(e, unlock, { capture: true })
      this.cleanupUnlock = null
    }
  }

  get state(): LiveSessionState {
    return this.stateValue
  }

  onUpdate(listener: (u: LiveUpdate) => void): () => void {
    this.listeners.add(listener)
    if (this.latest) this.call(listener, this.latest)
    return () => {
      this.listeners.delete(listener)
    }
  }

  pause(): void {
    if (this.stateValue !== 'running') return
    this.stateValue = 'paused'
    this.toWorklet({ type: 'pause' })
    this.recording?.pause()
    this.toWorker({ type: 'pause' })
    this.emit({ ...this.snapshot(), level: 0 })
  }

  resume(): void {
    if (this.stateValue !== 'paused') return
    this.stateValue = 'running'
    if (this.ended) {
      // nothing more can arrive; only the state changes
      this.emit(this.snapshot())
      return
    }
    if (this.graph.ctx.state !== 'running') this.graph.ctx.resume().catch(() => undefined)
    this.toWorklet({ type: 'resume' })
    this.recording?.resume()
    this.toWorker({ type: 'resume' })
    this.emit(this.snapshot())
  }

  stop(): Promise<LiveResult> {
    if (!this.stopping) this.stopping = this.doStop()
    return this.stopping
  }

  // ---------------------------------------------------------------------------------------

  private async doStop(): Promise<LiveResult> {
    const wasRunning = this.stateValue === 'running' && !this.ended
    this.stateValue = 'stopped'
    const result = new Promise<{ chords: AnalyzerChord[]; duration: number } | null>((resolve) => {
      this.resultWaiter = resolve
    })
    // flush the input: the worklet sends its last samples and an end marker down the same port
    if (this.graph.worklet && wasRunning && !this.error) {
      this.toWorklet({ type: 'end' })
      setTimeout(() => this.toWorker({ type: 'finish' }), FINISH_NUDGE_MS)
    } else {
      if (this.graph.worklet) this.toWorklet({ type: 'end' })
      this.toWorker({ type: 'finish' })
    }
    const [audio, analysis] = await Promise.all([
      this.recording ? this.recording.stop() : Promise.resolve(null),
      this.error ? Promise.resolve(null) : withTimeout(result, RESULT_TIMEOUT_MS, null),
    ])
    this.resultWaiter = null
    let chords: LiveChord[]
    let duration: number
    if (analysis) {
      chords = analysis.chords.map(toLive)
      duration = analysis.duration
    } else {
      // the worker failed or timed out: keep what was shown
      duration = this.latest?.time ?? 0
      chords = [...this.finals, ...this.open].map((c) => ({ ...c, provisional: false }))
      if (chords.length) chords[chords.length - 1].end = Math.max(chords[chords.length - 1].end, duration)
    }
    this.finals = chords
    this.open = []
    this.teardown()
    this.emit({ ...this.snapshot(), time: duration, level: 0 })
    return { audio, mimeType: audio ? this.recording?.mimeType || audio.type : '', duration, chords }
  }

  private teardown(): void {
    this.cleanupTrackListeners()
    this.cleanupUnlock?.()
    const { ctx, source, node } = this.graph
    try {
      source.disconnect()
      node.disconnect()
    } catch {
      /* already disconnected */
    }
    if (this.graph.worklet) (node as AudioWorkletNode).port.onmessage = null
    else (node as ScriptProcessorNode).onaudioprocess = null
    ctx.onstatechange = null
    void ctx.close().catch(() => undefined)
    this.worker.onmessage = null
    this.worker.terminate()
    if (!this.options.keepTracks) this.stream.getTracks().forEach((t) => t.stop())
  }

  private toWorker(msg: ToWorker): void {
    try {
      this.worker.postMessage(msg)
    } catch {
      /* terminated */
    }
  }

  private toWorklet(msg: ToWorklet): void {
    if (!this.graph.worklet) {
      if (msg.type === 'pause') this.graph.gate.paused = true
      else if (msg.type === 'resume') this.graph.gate.paused = false
      return
    }
    try {
      ;(this.graph.node as AudioWorkletNode).port.postMessage(msg)
    } catch {
      /* closed */
    }
  }

  private onWorker(msg: FromWorker): void {
    if (!msg) return
    if (msg.type === 'result') {
      this.resultWaiter?.({ chords: msg.chords, duration: msg.duration })
      return
    }
    if (msg.type === 'error') {
      if (this.error) return
      this.error = msg.message
      console.error('live:', msg.message)
      // analysis is gone, recording goes on; what was shown stays as history
      this.finals.push(...this.open.map((c) => ({ ...c, provisional: false })))
      this.open = []
      this.resultWaiter?.(null)
      if (this.stateValue !== 'stopped') this.emit(this.snapshot())
      return
    }
    if (this.stateValue === 'stopped') return
    this.onUpdateMessage(msg)
  }

  private onUpdateMessage(msg: WorkerUpdate): void {
    for (const c of msg.finalized) this.finals.push(toLive(c))
    this.open = msg.open.map(toLive)
    const paused = this.stateValue === 'paused'
    this.emit({
      ...this.snapshot(),
      time: msg.time,
      level: paused || this.ended ? 0 : msg.level,
      key: msg.key,
      tempo: msg.tempo,
      stats: { load: msg.load, delay: msg.delay, tuning: msg.tuning },
    })
  }

  /** The latest update with the current state (fields not given keep their last values). */
  private snapshot(): LiveUpdate {
    const prev = this.latest
    const open = this.open
    const current = this.stateValue === 'stopped' ? null : (open[open.length - 1] ?? null)
    const rest = current ? open.slice(0, -1) : open
    const history = rest.length ? this.finals.concat(rest) : this.finals.slice()
    return {
      time: prev?.time ?? 0,
      current,
      history,
      level: prev?.level ?? 0,
      key: prev?.key ?? null,
      tempo: prev?.tempo ?? null,
      state: this.stateValue,
      ended: this.ended || undefined,
      error: this.error,
      stats: prev?.stats,
    }
  }

  private emit(u: LiveUpdate): void {
    this.latest = u
    for (const l of [...this.listeners]) this.call(l, u)
  }

  private call(listener: (u: LiveUpdate) => void, u: LiveUpdate): void {
    try {
      listener(u)
    } catch (err) {
      console.error('live session listener failed', err)
    }
  }
}

async function buildGraph(ctx: AudioContext, stream: MediaStream, worker: Worker, paused: boolean, analyze: boolean): Promise<Graph> {
  const source = ctx.createMediaStreamSource(stream)
  const gate = { paused }
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      await ctx.audioWorklet.addModule(workletUrl)
      const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      const channel = new MessageChannel()
      if (paused) node.port.postMessage({ type: 'pause' } satisfies ToWorklet)
      node.port.postMessage({ type: 'port', port: channel.port1 } satisfies ToWorklet, [channel.port1])
      worker.postMessage({ type: 'init', sampleRate: ctx.sampleRate, port: channel.port2, analyze } satisfies ToWorker, [channel.port2])
      source.connect(node)
      // a silent output keeps the node pulled by the graph in every browser
      node.connect(ctx.destination)
      return { ctx, source, node, worklet: true, gate }
    } catch (err) {
      console.warn('live: AudioWorklet unavailable, falling back to ScriptProcessorNode', err)
    }
  }
  // fallback (no AudioWorklet, e.g. an insecure context or an old browser): the main thread forwards PCM
  const channels = Math.max(1, Math.min(2, stream.getAudioTracks()[0]?.getSettings?.().channelCount ?? 2))
  const node = ctx.createScriptProcessor(WORKLET_BATCH * 2, channels, 1)
  worker.postMessage({ type: 'init', sampleRate: ctx.sampleRate, analyze } satisfies ToWorker)
  node.onaudioprocess = (e: AudioProcessingEvent) => {
    if (gate.paused) return
    const input = e.inputBuffer
    const n = input.length
    const out = new Float32Array(n)
    const k = input.numberOfChannels
    for (let c = 0; c < k; c++) {
      const ch = input.getChannelData(c)
      for (let i = 0; i < n; i++) out[i] += ch[i] / k
    }
    worker.postMessage({ type: 'pcm', samples: out } satisfies ToWorker, [out.buffer])
  }
  source.connect(node)
  node.connect(ctx.destination)
  return { ctx, source, node, worklet: false, gate }
}

/**
 * Starts listening to `stream` (from captureMicrophone / captureTabAudio): live chords while it
 * plays (unless `analyze: false`), and (by default) a recording of it. Rejects with a CaptureError; the stream's tracks
 * are stopped then unless `keepTracks`.
 */
export async function startLiveSession(stream: MediaStream, options: LiveOptions = {}): Promise<LiveSession> {
  const record = options.record ?? true
  const Ctx = audioContextCtor()
  const stopTracks = () => {
    if (!options.keepTracks) stream.getTracks().forEach((t) => t.stop())
  }
  if (!stream || typeof stream.getAudioTracks !== 'function' || stream.getAudioTracks().length === 0) {
    stopTracks()
    throw new CaptureError('no-audio', 'the stream has no audio track')
  }
  if (!Ctx || typeof Worker === 'undefined') {
    stopTracks()
    throw new CaptureError('unsupported', 'this browser cannot analyze audio live (Web Audio or Web Workers unavailable)')
  }
  let ctx: AudioContext | null = null
  let worker: Worker | null = null
  try {
    ctx = new Ctx({ latencyHint: 'interactive' })
    // created after a user gesture it starts running; otherwise try (it may stay suspended
    // until the next gesture, which resume() on the session retries)
    if (ctx.state !== 'running') await withTimeout(ctx.resume(), 800, undefined)
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'chords-live' })
    const graph = await buildGraph(ctx, stream, worker, !!options.paused, options.analyze ?? true)
    const recording = record ? createRecording(stream, options.audioBitsPerSecond, !!options.paused) : null
    return new Session(stream, graph, worker, recording, options)
  } catch (err) {
    worker?.terminate()
    void ctx?.close().catch(() => undefined)
    stopTracks()
    if (err instanceof CaptureError) throw err
    throw new CaptureError('failed', err instanceof Error ? err.message : String(err))
  }
}
