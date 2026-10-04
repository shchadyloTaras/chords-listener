// Dev-only harness for live listening (frontend/live-harness.html, not part of the build):
// plays a synthesized chord progression with known chords through an AudioContext into a
// MediaStreamAudioDestinationNode and runs startLiveSession() on that stream, so the whole
// live pipeline (AudioWorklet -> worker -> updates -> <LiveChordsView/>) runs without mic or
// screen-capture permissions. Measures wall-clock latency per chord change (session update and
// on-screen), update rate, worker load, main-thread render time and final accuracy.
// window.__liveHarness exposes the controls and metrics for automated checks.
/* oxlint-disable react/only-export-components */

import { Profiler, StrictMode, useEffect } from 'react'
import { create } from 'zustand'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { LiveChordsView } from '../components/live'
import { t } from '../i18n'
import {
  CaptureError, canCaptureTab, captureMicrophone, captureTabAudio, startLiveSession, type LiveChord, type LiveResult,
  type LiveSession, type LiveUpdate,
} from '../lib/live'
import { agreement, renderSong, type SongSpec, type TruthSegment } from '../lib/live/testing/songs'
import { useApp } from '../store'

const PROGRAM: SongSpec[] = [
  { name: 'pop', bpm: 120, beatsPerChord: 4, chords: ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F'], leadIn: 1.5, tail: 0 },
  { name: 'fast', bpm: 132, beatsPerChord: 2, chords: ['E', 'B', 'C#m', 'A', 'E', 'B', 'C#m', 'A'], leadIn: 0, tail: 0 },
  { name: 'sevenths', bpm: 100, beatsPerChord: 4, chords: ['Dm7', 'G7', 'Cmaj7', 'Am7'], leadIn: 0, tail: 2.5 },
]

interface Program {
  audio: Float32Array
  sampleRate: number
  duration: number
  truth: TruthSegment[]
}

function buildProgram(sampleRate: number): Program {
  const parts = PROGRAM.map((spec) => renderSong(spec, sampleRate))
  const total = parts.reduce((s, p) => s + p.audio.length, 0)
  const audio = new Float32Array(total)
  const truth: TruthSegment[] = []
  let offset = 0
  for (const p of parts) {
    audio.set(p.audio, offset)
    const t0 = offset / sampleRate
    for (const seg of p.truth) {
      const s = { start: t0 + seg.start, end: t0 + seg.end, label: seg.label }
      if (s.end - s.start < 1e-6) continue
      const prev = truth[truth.length - 1]
      if (prev && prev.label === s.label) prev.end = s.end
      else truth.push(s)
    }
    offset += p.audio.length
  }
  return { audio, sampleRate, duration: total / sampleRate, truth }
}

interface UpdateEvent {
  wall: number
  time: number
  label: string | null
  provisional: boolean
  state: string | undefined
}

interface ChangeMetric {
  label: string
  /** truth time in the program (s) */
  at: number
  /** wall ms from the change to the session update showing it */
  update: number | null
  /** wall ms from the change to the hero text showing it */
  screen: number | null
  /** wall ms from the change until the chord was confirmed (non-provisional) */
  confirmed: number | null
}

interface Harness {
  program: Program | null
  /** performance.now() when the program's first sample plays */
  wallStart: number
  events: UpdateEvent[]
  hero: { wall: number; text: string }[]
  renderMs: number
  renders: number
  longTasks: number
  result: LiveResult | null
  session: LiveSession | null
  source: 'synthetic' | 'mic' | 'tab' | null
}

const H: Harness = {
  program: null,
  wallStart: 0,
  events: [],
  hero: [],
  renderMs: 0,
  renders: 0,
  longTasks: 0,
  result: null,
  session: null,
  source: null,
}

try {
  new PerformanceObserver((list) => {
    H.longTasks += list.getEntries().length
  }).observe({ type: 'longtask', buffered: false })
} catch {
  /* longtask timing unsupported */
}

/** Per-change latencies of the synthetic program. */
function changeMetrics(): ChangeMetric[] {
  const p = H.program
  if (!p || H.source !== 'synthetic') return []
  const out: ChangeMetric[] = []
  for (const seg of p.truth) {
    if (seg.label === 'N') continue
    const wall = H.wallStart + seg.start * 1000
    const until = H.wallStart + seg.end * 1000 + 1500
    const upd = H.events.find((e) => e.wall >= wall && e.wall <= until && e.label === seg.label)
    const conf = H.events.find((e) => e.wall >= wall && e.wall <= until && e.label === seg.label && !e.provisional)
    const scr = H.hero.find((h) => h.wall >= wall && h.wall <= until && h.text === seg.label)
    out.push({
      label: seg.label,
      at: seg.start,
      update: upd ? Math.round(upd.wall - wall) : null,
      screen: scr ? Math.round(scr.wall - wall) : null,
      confirmed: conf ? Math.round(conf.wall - wall) : null,
    })
  }
  return out
}

/** Best agreement of the final chords with the truth over session-time offsets 0..1.5 s. */
function finalAccuracy(chords: LiveChord[]): { offset: number; accuracy: number; guarded: number } | null {
  const p = H.program
  if (!p || H.source !== 'synthetic' || !chords.length) return null
  let best = { offset: 0, accuracy: -1, guarded: 0 }
  for (let off = 0; off <= 1.5; off += 0.01) {
    const shifted = chords.map((c) => ({ ...c, start: c.start - off, end: c.end - off }))
    const acc = agreement(shifted, p.truth, 0, p.duration)
    if (acc > best.accuracy) best = { offset: Math.round(off * 100) / 100, accuracy: acc, guarded: agreement(shifted, p.truth, 0, p.duration, 0.15) }
  }
  return best
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  return a[a.length >> 1]
}

function metrics() {
  const changes = changeMetrics()
  const upd = changes.map((c) => c.update).filter((v): v is number => v != null)
  const scr = changes.map((c) => c.screen).filter((v): v is number => v != null)
  const conf = changes.map((c) => c.confirmed).filter((v): v is number => v != null)
  const ev = H.events
  const span = ev.length > 1 ? (ev[ev.length - 1].wall - ev[0].wall) / 1000 : 0
  let maxGap = 0
  for (let i = 1; i < ev.length; i++) maxGap = Math.max(maxGap, ev[i].wall - ev[i - 1].wall)
  const last = H.session ? latestUpdate : null
  return {
    source: H.source,
    changes,
    latency: {
      updateMedianMs: median(upd),
      updateMaxMs: upd.length ? Math.max(...upd) : null,
      screenMedianMs: median(scr),
      screenMaxMs: scr.length ? Math.max(...scr) : null,
      confirmedMedianMs: median(conf),
      missed: changes.filter((c) => c.update == null).length,
    },
    updates: { count: ev.length, perSecond: span > 0 ? Math.round((ev.length / span) * 10) / 10 : null, maxGapMs: Math.round(maxGap) },
    workerLoad: last?.stats?.load ?? null,
    analysisDelay: last?.stats?.delay ?? null,
    tuning: last?.stats?.tuning ?? null,
    key: last?.key?.name ?? null,
    tempo: last?.tempo ?? null,
    main: { renders: H.renders, renderMs: Math.round(H.renderMs), renderMsPerSecond: span > 0 ? Math.round((H.renderMs / span) * 100) / 100 : null, longTasks: H.longTasks },
    result: H.result
      ? {
          duration: H.result.duration,
          mimeType: H.result.mimeType,
          audioBytes: H.result.audio?.size ?? 0,
          chords: H.result.chords.length,
          labels: H.result.chords.map((c) => `${c.label}@${c.start.toFixed(2)}`).join(' '),
          accuracy: finalAccuracy(H.result.chords),
        }
      : null,
  }
}

let latestUpdate: LiveUpdate | null = null

// ---------------------------------------------------------------------------------------
// controller (module level: event handlers and automation share it)

interface HarnessUi {
  session: LiveSession | null
  status: string
  compact: boolean
  monitor: boolean
  report: ReturnType<typeof metrics> | null
}

const useHarness = create<HarnessUi>(() => ({ session: null, status: '', compact: false, monitor: false, report: null }))

let srcCtx: AudioContext | null = null
let monitorGain: GainNode | null = null
let unsubscribe: (() => void) | null = null
let reportTimer = 0

function setMonitor(on: boolean): void {
  useHarness.setState({ monitor: on })
  if (monitorGain) monitorGain.gain.value = on ? 0.5 : 0
}

function track(session: LiveSession): void {
  unsubscribe?.()
  unsubscribe = session.onUpdate((u) => {
    latestUpdate = u
    H.events.push({ wall: performance.now(), time: u.time, label: u.current?.label ?? null, provisional: !!u.current?.provisional, state: u.state })
  })
  window.clearInterval(reportTimer)
  reportTimer = window.setInterval(() => useHarness.setState({ report: metrics() }), 1000)
}

function reset(source: Harness['source']): void {
  H.events = []
  H.hero = []
  H.renderMs = 0
  H.renders = 0
  H.longTasks = 0
  H.result = null
  H.source = source
  H.program = null
  latestUpdate = null
}

async function begin(source: 'synthetic' | 'mic' | 'tab'): Promise<void> {
  if (H.session && H.session.state !== 'stopped') await stop()
  reset(source)
  useHarness.setState({ status: '', report: null })
  try {
    if (source === 'synthetic') {
      const ctx = new AudioContext()
      srcCtx = ctx
      const program = buildProgram(ctx.sampleRate)
      H.program = program
      const buf = ctx.createBuffer(1, program.audio.length, ctx.sampleRate)
      buf.copyToChannel(program.audio as Float32Array<ArrayBuffer>, 0)
      const node = ctx.createBufferSource()
      node.buffer = buf
      const dest = ctx.createMediaStreamDestination()
      const gain = ctx.createGain()
      gain.gain.value = useHarness.getState().monitor ? 0.5 : 0
      monitorGain = gain
      node.connect(dest)
      node.connect(gain).connect(ctx.destination)
      const s = await startLiveSession(dest.stream)
      H.session = s
      track(s)
      useHarness.setState({ session: s })
      const startAt = ctx.currentTime + 0.25
      H.wallStart = performance.now() + (startAt - ctx.currentTime) * 1000
      node.start(startAt)
      node.onended = () => useHarness.setState({ status: 'program finished' })
    } else {
      const stream = source === 'mic' ? await captureMicrophone() : await captureTabAudio()
      const s = await startLiveSession(stream)
      H.session = s
      track(s)
      useHarness.setState({ session: s })
    }
  } catch (err) {
    const code = err instanceof CaptureError ? err.code : 'failed'
    useHarness.setState({ status: `${code}: ${t(`live.error.${code}`)} (${err instanceof Error ? err.message : String(err)})` })
  }
}

async function stop(): Promise<LiveResult | null> {
  const s = H.session
  if (!s) return null
  const result = await s.stop()
  H.result = result
  void srcCtx?.close().catch(() => undefined)
  srcCtx = null
  monitorGain = null
  window.clearInterval(reportTimer)
  useHarness.setState({
    report: metrics(),
    status: `stopped: ${result.duration.toFixed(1)} s, ${result.chords.length} chords, ${result.audio ? `${(result.audio.size / 1024).toFixed(0)} KB ${result.mimeType}` : 'no audio'}`,
  })
  return result
}

/** Timestamps every change of the hero chord text (what is on screen). */
function observeHero(el: HTMLElement | null): void {
  if (!el) return
  let lastText = ''
  new MutationObserver(() => {
    const heroes = el.querySelectorAll('.lv-hero')
    const text = heroes[heroes.length - 1]?.textContent ?? ''
    if (text !== lastText) {
      lastText = text
      H.hero.push({ wall: performance.now(), text })
    }
  }).observe(el, { subtree: true, childList: true, characterData: true })
}

function onRender(_id: string, _phase: string, actual: number): void {
  H.renderMs += actual
  H.renders++
}

;(window as unknown as { __liveHarness: unknown }).__liveHarness = {
  start: (source: 'synthetic' | 'mic' | 'tab' = 'synthetic') => begin(source),
  pause: () => H.session?.pause(),
  resume: () => H.session?.resume(),
  stop: () => stop().then(() => metrics()),
  metrics,
  setCompact: (on: boolean) => useHarness.setState({ compact: on }),
  get state() {
    return H.session?.state ?? 'idle'
  },
  get program() {
    return H.program ? { duration: H.program.duration, truth: H.program.truth } : null
  },
  H,
}

function Harness() {
  const theme = useApp((s) => s.theme)
  const lang = useApp((s) => s.lang)
  const setSetting = useApp((s) => s.setSetting)
  const { session, status, compact, monitor, report } = useHarness()
  const state = session?.state

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark')
  }, [theme])

  const btn = 'h-9 rounded-lg px-3 text-sm bg-surface-2 hover:bg-surface-3 disabled:opacity-40'
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <button className={`${btn} font-semibold`} onClick={() => void begin('synthetic')}>
          ▶ Synthetic progression
        </button>
        <button className={btn} onClick={() => void begin('mic')}>
          Mic
        </button>
        <button className={btn} onClick={() => void begin('tab')} title={canCaptureTab() ? '' : 'tab capture unsupported here'}>
          Tab {canCaptureTab() ? '' : '(unsupported)'}
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button className={btn} disabled={state !== 'running'} onClick={() => session?.pause()}>
          Pause
        </button>
        <button className={btn} disabled={state !== 'paused'} onClick={() => session?.resume()}>
          Resume
        </button>
        <button className={btn} disabled={!session || state === 'stopped'} onClick={() => void stop()}>
          Stop
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} /> hear it
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={compact} onChange={(e) => useHarness.setState({ compact: e.target.checked })} /> compact
        </label>
        <button className={btn} onClick={() => setSetting('theme', theme === 'dark' ? 'light' : 'dark')}>
          {theme}
        </button>
        <button className={btn} onClick={() => setSetting('lang', lang === 'uk' ? 'en' : 'uk')}>
          {lang}
        </button>
      </div>
      {status && <p className="text-sm text-muted">{status}</p>}

      <div ref={observeHero}>
        <Profiler id="live" onRender={onRender}>
          <LiveChordsView
            session={session}
            compact={compact}
            title={session && H.source === 'synthetic' ? 'Synthetic: C G Am F · E B C#m A · Dm7 G7 Cmaj7 Am7' : undefined}
          />
        </Profiler>
      </div>

      {report && (
        <pre className="overflow-x-auto rounded-xl border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-muted">
          {JSON.stringify(
            {
              ...report,
              changes: report.changes.map(
                (c) => `${c.label}@${c.at.toFixed(2)} upd ${c.update ?? '—'} ms, screen ${c.screen ?? '—'} ms, confirmed ${c.confirmed ?? '—'} ms`,
              ),
            },
            null,
            1,
          )}
        </pre>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)
