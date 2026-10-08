// "Живе фортепіано" ("Жива фісгармонія" on the harmonium): notes falling onto a keyboard whose keys go
// down in sync with the audio. By default it plays the song's chords the way a player accompanies it
// (./chordShapes, nothing to transcribe): on the piano the left hand's bass and the right hand's chord
// of the diagram on the beats, on the harmonium each chord's shape held until the next chord. The
// piano can instead show the recording's own notes (settings.liveKeysSource = 'song': transcribed once
// per track, see lib/transcription — from the instruments stem when the server separated the vocals).
// Chord-preview notes (clicks, the play-along) light keys too, and when the vocals were transcribed the
// sung melody shows as an outlined overlay with its own toggle. Under the title: in chord mode a hint;
// with the song's notes what the panel is doing, then (notes ready) a legend for the two kinds of bars,
// or an offer to separate the voice when the notes still come from the full mix.
// Lazy-loaded by LivePianoSlot; rendered under the now-playing hero when the instrument is a keyboard:
// the piano's keys fitted to the notes, the harmonium's own 37 keys (C3–C6).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { AudioLines, LoaderCircle, Mic, RotateCcw, X } from 'lucide-react'
import { useT } from '../../../i18n'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { onLiveNotes } from '../../../lib/liveNotes'
import { isMinorQuality } from '../../../lib/music/chord'
import { keysNotesReady } from '../../../lib/tour/trigger'
import { useConnection } from '../../../lib/serverMode'
import { isAdminRefusal } from '../../../lib/serviceStatus'
import { requestNotes, type NotesState } from '../../../lib/transcription'
import { fetchStem, startVocals, useVocals, vocalsSupport, type VocalsState } from '../../../lib/vocals'
import { useApp, type LiveKeysSource } from '../../../store'
import { useTourFlags, useTourTrigger } from '../../tour/hooks'
import { useChordModel } from '../model'
import { usePianoNotes } from '../score/pianoNotes'
import { useScoreSettings } from '../score/scoreSettings'
import { IconButton } from '../ui/controls'
import { errorText } from '../../jobs/errorText'
import { useCancelVocals } from '../useCancelVocals'
import { noteName } from './keyboard'
import { readPalette } from './palette'
import { usePulseGrid } from '../tempo/usePulseGrid'
import { Segmented } from '../ui/controls'
import { harmoniumShapeNotes, pianoShapeNotes } from './chordShapes'
import { PianoRenderer, type RollChord } from './renderer'
import { SyncControl } from './SyncControl'

const ANNOUNCE_EVERY_MS = 1500

export default function LivePiano() {
  const t = useT()
  const model = useChordModel()
  const { track, chords, spelling, rhythm, transpose } = model
  const setSetting = useApp((s) => s.setSetting)
  const keyboard = useApp((s) => (s.instrument === 'harmonium' ? 'harmonium' : 'piano'))
  const harmonium = keyboard === 'harmonium'
  /** the panel is named after the instrument: "Live harmonium" on the harmonium */
  const nameSuffix = harmonium ? '.harmonium' : ''
  // the chords as a player takes them (the harmonium always): no transcription
  const liveSource = useApp((s) => s.liveKeysSource)
  const chordMode = harmonium || liveSource !== 'song'
  const grid = usePulseGrid()
  const { notes, source } = usePianoNotes(chordMode ? null : track)
  const shapes = useMemo(
    () => (!chordMode ? null : harmonium ? harmoniumShapeNotes(chords, transpose) : pianoShapeNotes(chords, grid, transpose)),
    [chordMode, harmonium, chords, grid, transpose],
  )
  // transcribed in audio time; a recording linked to a video (a YouTube fragment) plays at audio time + startOffset
  const transcribed = notes.status === 'ready' ? notes.index : null
  const offset = track.startOffset ?? 0
  const songIndex = useMemo(() => transcribed?.shifted(offset) ?? null, [transcribed, offset])
  const songNotes = shapes ?? songIndex
  // the Live keys tour: the panel is shown with its notes ready (never the demo: it has no audio)
  const notesReady = shapes ? shapes.count > 0 && !!track.audioUrl : keysNotesReady(notes)
  useTourFlags({ keysPanel: true, keysReady: notesReady })
  useTourTrigger('keys', notesReady)
  // a track that says it has no vocals is "missing" without asking the server (the offer below); one that
  // does not say is not asked either — opening a song must not wake the cloud
  const vocals = useVocals(track, { knownOnly: track.vocals !== false })
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
    renderer.current?.setKeyboard(keyboard)
  }, [keyboard])

  useEffect(() => {
    renderer.current?.setNotes(songNotes)
  }, [songNotes])

  useEffect(() => {
    renderer.current?.setVocals(showVocals && vocals.status === 'ready' ? vocals.index : null)
  }, [vocals, showVocals])

  useEffect(() => {
    renderer.current?.setTranspose(transpose)
  }, [transpose])

  useEffect(() => {
    renderer.current?.setSpelling(spelling)
  }, [spelling])

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
    useApp.getState().toast(t(`keys.hidden${nameSuffix}`), 'info', { label: t('keys.show'), run: () => useApp.getState().setSetting('liveKeys', true) })
  }, [setSetting, t, nameSuffix])

  const progress = !chordMode && notes.status === 'computing' ? notes.progress : null
  const canRecompute = !chordMode && (notes.status === 'ready' || notes.status === 'error')

  return (
    <section aria-label={t(`keys.title${nameSuffix}`)} className="mt-3 overflow-hidden rounded-[22px] border border-border bg-surface">
      <div className="relative flex items-center gap-2 px-4 py-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[15px] leading-tight font-semibold tracking-tight">{t(`keys.title${nameSuffix}`)}</h2>
          {chordMode ? (
            <p className="truncate text-xs text-muted">{t(harmonium ? 'keys.harmonium.hint' : 'keys.piano.hint')}</p>
          ) : (
            <Status state={notes} onRetry={() => request()} />
          )}
          <VocalsLine ready={!!songNotes?.count} offer={!chordMode && source === 'mix'} chords={chordMode} vocals={vocals} showVocals={showVocals} />
        </div>
        {vocals.status === 'ready' && (
          <IconButton
            label={t('score.live.vocals.title')}
            data-tour="keys.voice"
            size="sm"
            active={showVocals}
            aria-pressed={showVocals}
            onClick={() => setScoreSetting('liveVocals', !showVocals)}
          >
            <Mic size={15} />
          </IconButton>
        )}
        {!harmonium && (
          <Segmented<LiveKeysSource>
            size="sm"
            label={t('keys.source.title')}
            value={liveSource}
            onChange={(v) => setSetting('liveKeysSource', v)}
            options={[
              { value: 'chords', label: t('keys.source.chords'), title: t('keys.source.chords.title') },
              { value: 'song', label: t('keys.source.song'), title: t('keys.source.song.title') },
            ]}
          />
        )}
        <SyncControl />
        {canRecompute && (
          <IconButton label={t('keys.recompute.title')} size="sm" onClick={() => request(true)}>
            <RotateCcw size={15} />
          </IconButton>
        )}
        <IconButton label={t(`keys.hide${nameSuffix}`)} size="sm" onClick={hide}>
          <X size={16} />
        </IconButton>
        {progress !== null && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] bg-border" aria-hidden>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div ref={wrap} className="relative border-t border-border" data-tour="keys.canvas">
        <canvas ref={canvas} role="img" aria-label={t(harmonium ? 'keys.canvas.harmonium' : chordMode ? 'keys.canvas.chords' : 'keys.canvas')} className="block w-full" style={{ height: layout.height || undefined }} />
        {layout.roll > 0 && !chordMode && <RollMessage state={notes} height={layout.roll} />}
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

/**
 * Once the notes are there: what the outlined bars are (the voice, when shown), or — notes from the
 * full mix, voice and instruments together (`offer`) — a one-line offer to separate the voice on the
 * server. In chord mode the coloured bars are the chords.
 */
export function VocalsLine({
  ready,
  offer,
  chords,
  vocals,
  showVocals,
}: {
  ready: boolean
  offer: boolean
  chords: boolean
  vocals: VocalsState
  showVocals: boolean
}) {
  const t = useT()
  const { track } = useChordModel()
  // re-render when the connection (or the cloud's features) change: they decide whether the offer works.
  // Only starting asks the cloud anything (startVocals); showing the offer never does.
  useConnection((s) => s.status)
  useConnection((s) => s.health)
  const { cancelling, cancel } = useCancelVocals(track)
  if (!ready) return null
  const line = 'flex min-w-0 items-center gap-1.5 text-xs text-muted'
  switch (vocals.status) {
    case 'ready':
      if (!showVocals) return null
      return (
        <div className={clsx(line, 'gap-3')} role="note" aria-label={t(chords ? 'keys.legend.aria.harmonium' : 'keys.legend.aria')}>
          <span className="inline-flex items-center gap-1.5" aria-hidden>
            <span className="h-2 w-4 rounded-[3px]" style={{ background: 'linear-gradient(90deg, var(--chord-0), var(--chord-4), var(--chord-8))' }} />
            {t(chords ? 'keys.legend.chords' : 'keys.legend.instruments')}
          </span>
          <span className="inline-flex items-center gap-1.5" aria-hidden>
            <span className="h-2 w-4 rounded-[3px] border-[1.5px] border-text bg-text/15" />
            {t('keys.legend.voice')}
          </span>
        </div>
      )
    case 'missing':
      if (!offer || vocalsSupport(track, { ask: false }) !== 'ok') return null
      return (
        <div className={line}>
          <span className="truncate">{t('keys.vocals.hint')}</span>
          <button
            type="button"
            data-tour="keys.voice"
            onClick={() => void startVocals(track)}
            title={t('keys.vocals.separate.title')}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-medium text-accent underline-offset-2 hover:underline"
          >
            <AudioLines size={13} aria-hidden />
            {t('keys.vocals.separate')}
          </button>
        </div>
      )
    case 'running':
      return (
        <div className={line}>
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden />
          <span className="truncate" aria-live="polite">
            {t('keys.vocals.running', { pct: Math.floor(vocals.progress * 100) })}
          </span>
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling || !vocals.jobId}
            title={t('score.vocals.cancel.title')}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-text underline-offset-2 hover:underline disabled:opacity-50"
          >
            {cancelling ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <X size={12} aria-hidden />}
            {t('score.vocals.cancel')}
          </button>
        </div>
      )
    case 'error': {
      if (vocals.during !== 'job') return null
      // quota and the administrator's switches: a retry would be refused again
      const refused = isAdminRefusal(vocals.code)
      const quota = vocals.code === 'quota_exceeded' || refused
      return (
        <div className={clsx(line, 'text-danger')}>
          <span className="truncate">{refused ? errorText(vocals.code) : t(quota ? 'score.vocals.quota' : 'keys.vocals.error')}</span>
          {!quota && (
            <button type="button" onClick={() => void startVocals(track)} className="shrink-0 rounded px-1.5 py-0.5 font-medium text-text underline-offset-2 hover:underline">
              {t('keys.retry')}
            </button>
          )}
        </div>
      )
    }
    default:
      return null
  }
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
