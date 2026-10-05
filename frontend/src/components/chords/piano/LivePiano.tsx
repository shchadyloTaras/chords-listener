// "Живе піаніно": the song's notes falling onto a piano keyboard whose keys go down in sync with the
// audio (notes transcribed once per track, see lib/transcription — from the instruments stem when the
// server separated the vocals), plus chord-preview notes and, when the vocals were transcribed, the
// sung melody as an outlined overlay with its own toggle.
// Lazy-loaded by LivePianoSlot; rendered under the now-playing hero when the instrument is piano.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { LoaderCircle, Mic, RotateCcw, X } from 'lucide-react'
import { useT } from '../../../i18n'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { onLiveNotes } from '../../../lib/liveNotes'
import { isMinorQuality } from '../../../lib/music/chord'
import { requestNotes, type NotesState } from '../../../lib/transcription'
import { fetchStem, useVocals } from '../../../lib/vocals'
import { useApp } from '../../../store'
import { useChordModel } from '../model'
import { usePianoNotes } from '../score/pianoNotes'
import { useScoreSettings } from '../score/scoreSettings'
import { IconButton } from '../ui/controls'
import { noteName } from './keyboard'
import { readPalette } from './palette'
import { PianoRenderer, type RollChord } from './renderer'
import { SyncControl } from './SyncControl'

const ANNOUNCE_EVERY_MS = 1500

export default function LivePiano() {
  const t = useT()
  const model = useChordModel()
  const { track, chords, spelling, rhythm, transpose } = model
  const setSetting = useApp((s) => s.setSetting)
  const { notes, source } = usePianoNotes(track)
  const vocals = useVocals(track, { knownOnly: true })
  const showVocals = useScoreSettings((s) => s.liveVocals)
  const setScoreSetting = useScoreSettings((s) => s.setScoreSetting)
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  /** the notes of the current source, (re)requested by the retry / recompute buttons */
  const request = useCallback(
    (force = false) =>
      requestNotes(
        source === 'instruments'
          ? { ...track, notesSource: 'instruments', loadAudio: (signal) => fetchStem(track, 'instruments', signal) }
          : track,
        { force },
      ),
    [track, source],
  )

  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<PianoRenderer | null>(null)
  const [layout, setLayout] = useState({ height: 0, roll: 0 })
  const keysRef = useRef<number[]>([])
  const [announce, setAnnounce] = useState('')

  // ---- renderer lifecycle
  useEffect(() => {
    const el = canvas.current
    const box = wrap.current
    if (!el || !box) return
    const r = new PianoRenderer(el, readPalette(), {
      onLayout: (height, roll) => setLayout((prev) => (prev.height === height && prev.roll === roll ? prev : { height, roll })),
      onKeys: (keys) => {
        keysRef.current = keys
      },
    })
    renderer.current = r
    r.resize(box.clientWidth)
    const ro = new ResizeObserver(([entry]) => r.resize(entry.contentRect.width))
    ro.observe(box)
    // theme switches change the CSS tokens on <html>
    const mo = new MutationObserver(() => r.setPalette(readPalette()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    const io =
      typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => r.setVisible(e.isIntersecting), { rootMargin: '80px' })
    io?.observe(box)
    const offPreview = onLiveNotes((n) => r.addPreview(n))
    const onDpr = () => r.resize(box.clientWidth)
    window.addEventListener('resize', onDpr)
    return () => {
      offPreview()
      ro.disconnect()
      mo.disconnect()
      io?.disconnect()
      window.removeEventListener('resize', onDpr)
      r.destroy()
      renderer.current = null
    }
  }, [])

  useEffect(() => {
    renderer.current?.setNotes(notes.status === 'ready' ? notes.index : null)
  }, [notes])

  useEffect(() => {
    renderer.current?.setVocals(showVocals && vocals.status === 'ready' ? vocals.index : null)
  }, [vocals, showVocals])

  useEffect(() => {
    renderer.current?.setTranspose(transpose)
  }, [transpose])

  useEffect(() => {
    renderer.current?.setReducedMotion(reduced)
  }, [reduced])

  const rollChords = useMemo<RollChord[]>(
    () =>
      chords
        .filter((c) => !c.isNone)
        .map((c) => ({ start: c.start, label: c.label, rootPc: c.rootPc, minor: isMinorQuality(c.quality) })),
    [chords],
  )
  useEffect(() => {
    renderer.current?.setChords(rollChords, rhythm.downbeats)
  }, [rollChords, rhythm.downbeats])

  // ---- screen-reader summary of the keys that are down, at most every 1.5 s
  useEffect(() => {
    let last = ''
    const id = window.setInterval(() => {
      const keys = keysRef.current
      const text = keys.length ? t('keys.sounding', { notes: keys.map((k) => noteName(k, spelling)).join(', ') }) : t('keys.silence')
      if (text !== last) {
        last = text
        setAnnounce(text)
      }
    }, ANNOUNCE_EVERY_MS)
    return () => window.clearInterval(id)
  }, [t, spelling])

  const hide = useCallback(() => {
    setSetting('liveKeys', false)
    useApp.getState().toast(t('keys.hidden'), 'info', { label: t('keys.show'), run: () => useApp.getState().setSetting('liveKeys', true) })
  }, [setSetting, t])

  const progress = notes.status === 'computing' ? notes.progress : null
  const canRecompute = notes.status === 'ready' || notes.status === 'error'

  return (
    <section aria-label={t('keys.title')} className="mt-3 overflow-hidden rounded-[22px] border border-border bg-surface">
      <div className="relative flex items-center gap-2 px-4 py-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[15px] leading-tight font-semibold tracking-tight">{t('keys.title')}</h2>
          <Status state={notes} onRetry={() => request()} />
        </div>
        {vocals.status === 'ready' && (
          <IconButton
            label={t('score.live.vocals.title')}
            size="sm"
            active={showVocals}
            aria-pressed={showVocals}
            onClick={() => setScoreSetting('liveVocals', !showVocals)}
          >
            <Mic size={15} />
          </IconButton>
        )}
        <SyncControl />
        {canRecompute && (
          <IconButton label={t('keys.recompute.title')} size="sm" onClick={() => request(true)}>
            <RotateCcw size={15} />
          </IconButton>
        )}
        <IconButton label={t('keys.hide')} size="sm" onClick={hide}>
          <X size={16} />
        </IconButton>
        {progress !== null && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] bg-border" aria-hidden>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div ref={wrap} className="relative border-t border-border">
        <canvas ref={canvas} role="img" aria-label={t('keys.canvas')} className="block w-full" style={{ height: layout.height || undefined }} />
        {layout.roll > 0 && <RollMessage state={notes} height={layout.roll} />}
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
      </div>
    </section>
  )
}

/** What the panel is doing (loading, recognizing, an error); nothing once the notes are there. */
function Status({ state, onRetry }: { state: NotesState; onRetry(): void }) {
  const t = useT()
  let text = ''
  let tone: 'muted' | 'error' = 'muted'
  switch (state.status) {
    case 'idle':
    case 'loading':
      text = t('keys.status.loading')
      break
    case 'computing':
      if (state.stage === 'audio') text = t('keys.status.audio')
      else if (state.stage === 'decode') text = t('keys.status.decode')
      else text = t('keys.status.computing', { pct: Math.floor(state.progress * 100) })
      break
    case 'ready':
      if (!state.index.count) text = t('keys.status.none')
      break
    case 'unavailable':
      text = t('keys.status.unavailable')
      break
    case 'error':
      text = t(`keys.error.${state.code}`)
      tone = 'error'
      break
  }
  if (!text) return null
  // screen readers hear the stage, not every percent
  const spoken = state.status === 'computing' ? t('keys.status.computingShort') : text
  return (
    <div className={clsx('flex min-w-0 items-center gap-1.5 text-xs', tone === 'error' ? 'text-danger' : 'text-muted')}>
      {(state.status === 'loading' || state.status === 'computing') && <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden />}
      <span className="truncate" aria-hidden>
        {text}
      </span>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
      {state.status === 'error' && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded px-1.5 py-0.5 font-medium text-text underline-offset-2 hover:underline">
          {t('keys.retry')}
        </button>
      )}
    </div>
  )
}

/** Explanations shown over the empty roll (first transcription, the demo without audio). */
function RollMessage({ state, height }: { state: NotesState; height: number }) {
  const t = useT()
  let text: string | null = null
  if (state.status === 'computing') text = t('keys.firstRun')
  else if (state.status === 'unavailable') text = t('keys.unavailable')
  if (!text) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center px-6" style={{ height }}>
      <p className="max-w-md rounded-xl bg-surface/85 px-3 py-2 text-center text-xs leading-relaxed text-muted backdrop-blur-sm">{text}</p>
    </div>
  )
}
