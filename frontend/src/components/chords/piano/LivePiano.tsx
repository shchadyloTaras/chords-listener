// "Живе піаніно": the song's notes falling onto a piano keyboard whose keys go down in sync with the
// audio (notes transcribed once per track, see lib/transcription), plus chord-preview notes.
// Lazy-loaded by LivePianoSlot; rendered under the now-playing hero when the instrument is piano.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useT } from '../../../i18n'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { onLiveNotes } from '../../../lib/liveNotes'
import { isMinorQuality } from '../../../lib/music/chord'
import { formatTranspose } from '../../../lib/music/key'
import { requestNotes, useTrackNotes, type NotesState } from '../../../lib/transcription'
import { useApp } from '../../../store'
import { useChordModel } from '../model'
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
  const lang = useApp((s) => s.lang)
  const setSetting = useApp((s) => s.setSetting)
  const notes = useTrackNotes(track)
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')

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

  const fmt = useMemo(() => new Intl.NumberFormat(lang === 'uk' ? 'uk-UA' : 'en-US'), [lang])
  const plural = useMemo(() => new Intl.PluralRules(lang === 'uk' ? 'uk' : 'en'), [lang])

  const progress = notes.status === 'computing' ? notes.progress : null
  const canRecompute = notes.status === 'ready' || notes.status === 'error'

  return (
    <section aria-label={t('keys.title')} className="mt-3 overflow-hidden rounded-[22px] border border-border bg-surface">
      <div className="relative flex items-center gap-2 px-4 py-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[15px] leading-tight font-semibold tracking-tight">{t('keys.title')}</h2>
          <Status state={notes} transpose={transpose} fmt={fmt} plural={plural} onRetry={() => requestNotes(track)} />
        </div>
        <SyncControl />
        {canRecompute && (
          <IconButton label={t('keys.recompute.title')} size="sm" onClick={() => requestNotes(track, { force: true })}>
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

function Status({
  state,
  transpose,
  fmt,
  plural,
  onRetry,
}: {
  state: NotesState
  transpose: number
  fmt: Intl.NumberFormat
  plural: Intl.PluralRules
  onRetry(): void
}) {
  const t = useT()
  let text = ''
  let title: string | undefined
  let tone: 'muted' | 'error' = 'muted'
  const extras: string[] = []
  switch (state.status) {
    case 'idle':
    case 'loading':
      text = t('keys.status.loading')
      break
    case 'computing':
      if (state.stage === 'audio') text = t('keys.status.audio')
      else if (state.stage === 'decode') text = t('keys.status.decode')
      else {
        text = t('keys.status.computing', { pct: Math.floor(state.progress * 100) })
        if (state.found > 0) extras.push(t('keys.status.found', { n: fmt.format(state.found) }))
      }
      break
    case 'ready': {
      const n = state.index.count
      text = n ? t(`keys.status.notes.${plural.select(n)}`, { n: fmt.format(n) }) : t('keys.status.none')
      if (transpose) extras.push(t('keys.status.transposed', { n: formatTranspose(transpose) }))
      if (!state.saved) extras.push(t('keys.status.notSaved'))
      title = state.stats
        ? t('keys.status.engine', { backend: `${state.stats.backend === 'webgl' ? 'WebGL' : 'CPU'}, ${(state.stats.modelMs / 1000).toFixed(1)} s` })
        : t('keys.status.savedTitle', { engine: state.engine })
      if (!state.saved) title += ` · ${t('keys.status.notSavedTitle')}`
      break
    }
    case 'unavailable':
      text = t('keys.status.unavailable')
      break
    case 'error':
      text = t(`keys.error.${state.code}`)
      title = state.message
      tone = 'error'
      break
  }
  // screen readers hear the stage, not every percent
  const shown = [text, ...extras].join(' · ')
  const spoken = state.status === 'computing' ? t('keys.status.computingShort') : shown
  return (
    <div className={clsx('flex min-w-0 items-center gap-1.5 text-xs', tone === 'error' ? 'text-danger' : 'text-muted')} title={title}>
      {(state.status === 'loading' || state.status === 'computing') && <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden />}
      <span className="truncate" aria-hidden>
        {shown}
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
  if (state.status === 'computing') text = state.backend === 'cpu' ? t('keys.firstRunCpu') : t('keys.firstRun')
  else if (state.status === 'unavailable') text = t('keys.unavailable')
  if (!text) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center px-6" style={{ height }}>
      <p className="max-w-md rounded-xl bg-surface/85 px-3 py-2 text-center text-xs leading-relaxed text-muted backdrop-blur-sm">{text}</p>
    </div>
  )
}
