// Dev-only playground (frontend/playground.html): mounts <ChordWorkspace/> with the demo track
// and a fake clock player, plus a minimal player bar standing in for the Shell's PlayerBar.
// Not part of the production build (vite builds index.html only).
// It is an entry module that mounts itself and exports nothing, so Fast Refresh's
// "only export components" rule does not apply here.
/* oxlint-disable react/only-export-components */

import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { ChordWorkspace } from '../components/chords'
import { formatTime } from '../lib/music/formats'
import { useApp, type PlayerController } from '../store'
import type { ChordSegment, Track } from '../types'
import { sampleTrack } from './sampleTrack'

function createFakePlayer(): PlayerController {
  let base = 0
  let startedAt = 0
  let playing = false
  let rate = 1
  let raf = 0
  const now = () => performance.now() / 1000
  const getTime = () => (playing ? base + (now() - startedAt) * rate : base)
  const frame = () => {
    const s = useApp.getState()
    let t = getTime()
    if (s.loop && t >= s.loop.end) {
      base = s.loop.start
      startedAt = now()
      t = base
    }
    if (t >= s.duration) {
      base = s.duration
      playing = false
      s.setPlayback({ currentTime: base, isPlaying: false })
      return
    }
    s.setPlayback({ currentTime: t })
    raf = requestAnimationFrame(frame)
  }
  return {
    play() {
      if (playing) return
      startedAt = now()
      playing = true
      useApp.getState().setPlayback({ isPlaying: true })
      raf = requestAnimationFrame(frame)
    },
    pause() {
      base = getTime()
      playing = false
      cancelAnimationFrame(raf)
      useApp.getState().setPlayback({ isPlaying: false, currentTime: base })
    },
    seek(t) {
      base = t
      startedAt = now()
    },
    setRate(r) {
      base = getTime()
      startedAt = now()
      rate = r
    },
    setVolume() {},
    getTime,
  }
}

/** ~520 segments of varied chords for performance checks. */
function stressTrack(): Track {
  const pool = ['Am', 'F', 'C', 'G', 'Dm7', 'E7', 'G/B', 'Cmaj7', 'Bdim', 'F#m7b5', 'Bb', 'Ebmaj7', 'C#m', 'Asus4', 'N']
  const beat = 60 / 112
  const chords: ChordSegment[] = []
  let t = 0
  for (let i = 0; i < 520; i++) {
    const label = pool[(i * 7 + (i >> 3)) % pool.length]
    const beats = [2, 4, 4, 2, 1, 4, 8][i % 7]
    const end = t + beats * beat
    if (chords.length && chords[chords.length - 1].label === label) chords[chords.length - 1].end = end
    else chords.push({ start: t, end, label, root: null, quality: null, bass: null, confidence: 0.35 + ((i * 13) % 60) / 100 })
    t = end
  }
  const beats = Array.from({ length: Math.floor(t / beat) }, (_, i) => +(i * beat).toFixed(3))
  return {
    ...sampleTrack,
    id: 'stress',
    title: 'Stress test',
    duration: t,
    tempo: 112,
    chords,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0.6 },
  }
}

function PlayerBar() {
  const isPlaying = useApp((s) => s.isPlaying)
  const time = useApp((s) => Math.floor(s.currentTime))
  const duration = useApp((s) => s.duration)
  const theme = useApp((s) => s.theme)
  const lang = useApp((s) => s.lang)
  const loop = useApp((s) => s.loop)
  const track = useApp((s) => s.track)
  const set = useApp((s) => s.setSetting)
  const btn = 'h-9 rounded-lg px-3 text-sm bg-surface-2 hover:bg-surface-3'
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex h-20 items-center gap-3 border-t border-border bg-surface px-4">
      <button className={`${btn} w-20 font-semibold`} onClick={() => useApp.getState().toggle()}>
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      <span className="font-mono text-xs text-muted tabular-nums">
        {formatTime(time)} / {formatTime(duration)}
      </span>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={time}
        onChange={(e) => useApp.getState().seek(+e.target.value)}
        className="min-w-0 flex-1 accent-[var(--accent)]"
        aria-label="seek"
      />
      {loop && (
        <button className={btn} onClick={() => useApp.getState().setLoop(null)}>
          loop ×
        </button>
      )}
      <button className={btn} onClick={() => set('theme', theme === 'dark' ? 'light' : 'dark')}>
        {theme}
      </button>
      <button className={btn} onClick={() => set('lang', lang === 'uk' ? 'en' : 'uk')}>
        {lang}
      </button>
      <button className={btn} onClick={() => useApp.getState().setTrack(track?.id === 'stress' ? sampleTrack : stressTrack())}>
        {track?.id === 'stress' ? 'demo' : 'stress'}
      </button>
    </div>
  )
}

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="fixed top-4 right-4 z-[70] flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-3 rounded-xl border border-border-strong bg-surface-3 px-4 py-2.5 text-sm shadow-lg">
          <span className={t.kind === 'error' ? 'text-danger' : t.kind === 'success' ? 'text-success' : 'text-muted'}>●</span>
          {t.message}
          {t.action && (
            <button className="font-semibold text-accent" onClick={() => t.action?.run()}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// One-time setup before the first render: fake player + demo track.
useApp.getState().registerController(createFakePlayer())
useApp.getState().setTrack(sampleTrack)

function Playground() {
  const theme = useApp((s) => s.theme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark')
  }, [theme])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,textarea')) {
        e.preventDefault()
        useApp.getState().toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <ChordWorkspace />
      <PlayerBar />
      <Toasts />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
)
