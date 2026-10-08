// "Ноти": the song as sheet music — the sung melody ("Вокал", when the server transcribed it) above a
// piano grand staff with the instruments' notes (or, at the simple level, the chord sheet's chords),
// chord symbols on top — drawn by OpenSheetMusicDisplay from the MusicXML that is also exported. A
// cursor follows the playback (auto-scroll with "follow"), clicking a note plays from there.
// Lazy-loaded (OSMD is a big library).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AudioLines, CloudUpload, Download, FileMusic, FileText, Hash, LoaderCircle, Mic, Music2, Piano, RotateCcw, X } from 'lucide-react'
import { useT } from '../../../i18n'
import { navigate, paths } from '../../../hooks/useRoute'
import { moveToCloud, onTransferDone, transferLabel, useTransfers } from '../../../lib/cloud/transfer'
import { isLocalId } from '../../../lib/local/tracks'
import { FALLBACK_FONT, registerScoreFont, SCORE_FONT } from '../../../lib/score/fonts'
import { baseOptions, configureRules, fracAt, measureLayout, OpenSheetMusicDisplay, xAt, type ScoreColors, type ScoreLayout } from '../../../lib/score/osmd'
import { SCORE_LEVELS, type Score, type ScoreLevel } from '../../../lib/score/types'
import { useConnection } from '../../../lib/serverMode'
import { isAdminRefusal } from '../../../lib/serviceStatus'
import { requestNotes, type NotesState } from '../../../lib/transcription'
import { loadVocals, startVocals, vocalsSupport, type VocalsState } from '../../../lib/vocals'
import { useApp } from '../../../store'
import { AccountButtons } from '../../account/AccountCta'
import { useCloudInvite } from '../../account/cloudInvite'
import { noteName } from '../piano/keyboard'
import { useClockEffect } from '../clock'
import { isTypingTarget } from '../hotkeys'
import { useChordModel } from '../model'
import { useChordUi } from '../uiStore'
import { useTourFlags, useTourTrigger } from '../../tour/hooks'
import { errorText } from '../../jobs/errorText'
import { useCancelVocals } from '../useCancelVocals'
import { Floating } from '../ui/Floating'
import { Divider, Segmented, ToggleChip } from '../ui/controls'
import { EXPORT_KINDS, exportScore, useScoreExport, type ExportKind } from './exportScore'
import { useScoreData } from './scoreData'
import { useScoreSettings } from './scoreSettings'

const SCORE_COLORS: Record<'dark' | 'light', ScoreColors> = {
  dark: { ink: '#E9E7E1', chords: '#FFB547' },
  light: { ink: '#1B1A1F', chords: '#A85F00' },
}

function useTheme(): 'dark' | 'light' {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [theme, setTheme] = useState<'dark' | 'light'>(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return theme
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** Full part names take a quarter of a phone's width: phones get the abbreviations ("Вок.", "Фп."). */
function shortNames(xml: string): string {
  return xml.replace(/<part-name>[^<]*<\/part-name>(\s*)<part-abbreviation>([^<]*)<\/part-abbreviation>/g, '<part-name>$2</part-name>$1<part-abbreviation>$2</part-abbreviation>')
}

/** Notation size by width: phones get a smaller staff so a bar or two fit per line. */
function zoomFor(width: number): number {
  if (width < 420) return 0.6
  if (width < 640) return 0.7
  if (width < 900) return 0.82
  return 0.92
}

export default function ScoreView() {
  const t = useT()
  const model = useChordModel()
  const data = useScoreData(model)
  const settings = useScoreSettings()
  // the Score tour: the view's header is on screen (the notes need not be ready)
  useTourTrigger('score', true)
  const set = settings.setScoreSetting
  const vocalsReady = data.vocals.status === 'ready'
  // the simple level's piano part is the chord sheet: nothing is transcribed for it
  const simple = settings.level === 'simple'

  return (
    <section aria-label={t('score.label')} className="overflow-hidden rounded-[22px] border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border py-2 pr-3 pl-3.5 sm:px-4">
        <div className="flex shrink-0 items-center gap-2">
          <FileMusic size={18} className="text-accent" aria-hidden />
          <h2 className="sr-only font-display text-[15px] font-semibold tracking-tight sm:not-sr-only">{t('score.title')}</h2>
        </div>
        <div className="cw-no-scrollbar cw-fade-end relative -my-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 pr-5" role="group" aria-label={t('score.title')}>
          <span className="flex shrink-0 items-center gap-1" data-tour="score.parts">
            <ToggleChip
              pressed={settings.vocals}
              onClick={() => set('vocals', !settings.vocals)}
              title={t('score.toggle.vocals.title')}
              icon={<Mic size={15} />}
              className={clsx(!vocalsReady && settings.vocals && 'opacity-80')}
            >
              {t('score.toggle.vocals')}
            </ToggleChip>
            <ToggleChip pressed={settings.piano} onClick={() => set('piano', !settings.piano)} title={t('score.toggle.piano.title')} icon={<Piano size={15} />}>
              {t('score.toggle.piano')}
            </ToggleChip>
          </span>
          <ToggleChip pressed={settings.chords} data-tour="score.chords" onClick={() => set('chords', !settings.chords)} title={t('score.toggle.chords.title')} icon={<Hash size={15} />}>
            {t('score.toggle.chords')}
          </ToggleChip>
          <Divider />
          <Segmented<ScoreLevel>
            tour="score.level"
            label={t('score.level')}
            value={settings.level}
            onChange={(v) => set('level', v)}
            options={SCORE_LEVELS.map((v) => ({ value: v, label: t(`score.level.${v}`), title: t(`score.level.${v}.title`) }))}
          />
        </div>
        <div className="shrink-0">
          <ExportMenu score={data.score} />
        </div>
      </div>

      <StatusLine piano={data.piano} vocals={data.vocals} showPiano={settings.piano && !simple} showVocals={settings.vocals} />
      {settings.vocals && <VocalsCard state={data.vocals} />}

      {data.score && data.xml ? (
        <ScoreCanvas xml={data.xml} score={data.score} />
      ) : (
        <Placeholder>
          {!settings.vocals && !settings.piano ? (
            t('score.empty')
          ) : simple ? (
            // a chord part is there at once: without one the sheet has no chords (the vocals card says the rest)
            settings.piano && <p>{t('score.piano.noChords')}</p>
          ) : (
            <PianoProgress state={data.piano} />
          )}
        </Placeholder>
      )}
    </section>
  )
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 px-6 py-12 text-center text-sm text-muted">
      <Music2 size={26} className="text-faint" aria-hidden />
      {children}
    </div>
  )
}

/** The instruments' transcription while there is no score yet. */
function PianoProgress({ state }: { state: NotesState }) {
  const t = useT()
  const { track } = useChordModel()
  switch (state.status) {
    case 'computing': {
      const text =
        state.stage === 'audio' ? t('score.piano.audio') : state.stage === 'decode' ? t('score.piano.decode') : t('score.piano.computing', { pct: Math.floor(state.progress * 100) })
      return (
        <div className="flex w-full max-w-sm flex-col items-center gap-2">
          <p className="flex items-center gap-2 text-text">
            <LoaderCircle size={15} className="animate-spin" aria-hidden />
            <span aria-live="polite">{text}</span>
          </p>
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </div>
          <p className="text-xs leading-relaxed">{t('score.piano.firstRun')}</p>
        </div>
      )
    }
    case 'error':
      return (
        <p className="text-danger" title={state.message}>
          {t('score.piano.error')}{' '}
          <button type="button" onClick={() => requestNotes(track)} className="font-medium text-text underline-offset-2 hover:underline">
            {t('score.retry')}
          </button>
        </p>
      )
    case 'unavailable':
      return <p>{t('score.piano.unavailable')}</p>
    default:
      return (
        <p className="flex items-center gap-2">
          <LoaderCircle size={15} className="animate-spin" aria-hidden />
          {t('score.piano.loading')}
        </p>
      )
  }
}

function StatusLine({
  piano,
  vocals,
  showPiano,
  showVocals,
}: {
  piano: NotesState
  vocals: VocalsState
  showPiano: boolean
  showVocals: boolean
}) {
  const t = useT()
  const spelling = useChordModel().spelling
  const items: ReactNode[] = []
  if (showVocals && vocals.status === 'ready') {
    const range = vocals.notes.range ?? null
    items.push(
      <span key="v" className="inline-flex items-center gap-1.5" title={t('score.legend.vocal')}>
        <Mic size={13} aria-hidden />
        {t('score.vocals.ready', {
          low: range ? noteName(range.low, spelling) : '—',
          high: range ? noteName(range.high, spelling) : '—',
        })}
      </span>,
    )
  }
  if (showPiano && piano.status === 'computing') {
    items.push(
      <span key="p" className="inline-flex items-center gap-1.5">
        <LoaderCircle size={13} className="animate-spin" aria-hidden />
        {t('score.piano.computing', { pct: Math.floor(piano.progress * 100) })}
      </span>,
    )
  }
  if (!items.length) return null
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-1.5 text-xs text-muted">{items}</div>
}

/** Vocal melody: start the server job, its progress, or why it is not possible here. */
/** The demo song (dev/sampleTrack.ts): it exists only in this browser, an account brings no vocals for it. */
const DEMO_TRACK_ID = 'demo'

export function VocalsCard({ state }: { state: VocalsState }) {
  const t = useT()
  const { track } = useChordModel()
  // a guest (no account, no server): vocals come with a free account
  const invite = useCloudInvite()
  const noServer = useConnection((s) => s.status !== 'server')
  const cloud = useConnection((s) => s.backend === 'cloud')
  // a song kept on this device: the cloud transcribes its vocals once it is moved there
  const local = isLocalId(track.id)
  const { cancelling, cancel } = useCancelVocals(track)
  const transfer = useTransfers((s) => (local ? s[track.id] : undefined))
  const moving = !!transfer && transfer.phase !== 'error'
  useEffect(() => {
    if (!local) return
    const id = track.id
    // moved: the copy on this device is gone, the page follows the song to the cloud
    return onTransferDone((done) => {
      if (done.localId === id) navigate(paths.track(done.trackId))
    })
  }, [local, track.id])
  const box = (children: ReactNode, tone: 'muted' | 'accent' = 'muted') => (
    <div className={clsx('flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-sm', tone === 'accent' ? 'bg-accent-soft/50' : 'bg-surface-2/50')}>{children}</div>
  )
  switch (state.status) {
    case 'missing':
      return box(
        <>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('score.vocals.missing.title')}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{t('score.vocals.missing.text')}</p>
          </div>
          <button
            type="button"
            onClick={() => void startVocals(track)}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg hover:brightness-105"
          >
            <AudioLines size={16} />
            {t('score.vocals.start')}
          </button>
        </>,
        'accent',
      )
    case 'running': {
      const stages = ['separate', 'melody'] as const
      const current = state.stage === 'queued' ? -1 : stages.indexOf(state.stage)
      return box(
        <div className="flex w-full flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-2 font-medium" aria-live="polite">
              <LoaderCircle size={15} className="animate-spin text-accent" aria-hidden />
              {t('score.vocals.running', { pct: Math.floor(state.progress * 100) })}
            </span>
            <ol className="flex items-center gap-1.5 text-xs">
              {state.stage === 'queued' && <li className="text-muted">{t('score.vocals.stage.queued')}</li>}
              {stages.map((s, i) => (
                <li key={s} className={clsx('flex items-center gap-1.5', i === current ? 'text-text' : i < current ? 'text-success' : 'text-faint')}>
                  {i > 0 && <span aria-hidden>→</span>}
                  {t(`score.vocals.stage.${s}`)}
                </li>
              ))}
            </ol>
            <button
              type="button"
              onClick={cancel}
              disabled={cancelling || !state.jobId}
              title={t('score.vocals.cancel.title')}
              className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted hover:bg-surface-3 hover:text-text disabled:opacity-50"
            >
              {cancelling ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : <X size={14} aria-hidden />}
              {t('score.vocals.cancel')}
            </button>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, Math.round(state.progress * 100))}%` }} />
          </div>
        </div>,
        'accent',
      )
    }
    case 'unavailable':
      if (state.reason === 'browser' && invite && noServer && track.id !== DEMO_TRACK_ID)
        return box(
          <>
            <div className="min-w-0 flex-1 basis-56">
              <p className="font-medium">{t('score.vocals.guest.title')}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t(local ? 'score.vocals.guestLocal.text' : 'score.vocals.guest.text')}</p>
            </div>
            <AccountButtons size="sm" className="shrink-0" reason="vocals" />
          </>,
          'accent',
        )
      if (state.reason === 'browser' && local && cloud)
        return box(
          <>
            <div className="min-w-0 flex-1 basis-56">
              <p className="font-medium">{t('score.vocals.guest.title')}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t('score.vocals.move.text')}</p>
            </div>
            <button
              type="button"
              disabled={moving}
              onClick={() => moveToCloud(track.id)}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg hover:brightness-105 disabled:opacity-60"
            >
              {moving ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <CloudUpload size={16} aria-hidden />}
              <span aria-live="polite">{transfer && moving ? transferLabel(t, transfer) : t('cloud.history.move')}</span>
            </button>
          </>,
          'accent',
        )
      return box(
        <>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t(state.reason === 'server' ? 'score.vocals.server.title' : 'score.vocals.browser.title')}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {state.reason === 'server'
                ? t('score.vocals.server.text')
                : t(track.id.startsWith('local-') ? 'score.vocals.browserTrack.text' : 'score.vocals.browser.text')}
            </p>
          </div>
        </>,
      )
    case 'error': {
      // the administrator's switches: worded in the cloud's own words, and a retry would be refused again
      const refused = isAdminRefusal(state.code)
      const text = refused
        ? errorText(state.code)
        : state.code === 'quota_exceeded'
          ? t('score.vocals.quota')
          : state.code === 'unauthorized'
            ? t('score.vocals.signin')
            : t(state.during === 'job' ? 'score.vocals.error' : 'score.vocals.loadError')
      return box(
        <>
          <p className="min-w-0 flex-1 text-danger" title={state.message}>
            {text}
          </p>
          {vocalsSupport(track) === 'ok' && state.code !== 'quota_exceeded' && !refused && (
            <button
              type="button"
              onClick={() => void (state.during === 'job' ? startVocals(track) : loadVocals(track, { force: true }))}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium hover:bg-surface-3"
            >
              <RotateCcw size={14} />
              {t('score.retry')}
            </button>
          )}
        </>,
      )
    }
    case 'loading':
      return box(
        <span className="inline-flex items-center gap-2 text-muted">
          <LoaderCircle size={14} className="animate-spin" aria-hidden />
          {t('score.vocals.loading')}
        </span>,
      )
    default:
      return null
  }
}

const KIND_ICON: Record<ExportKind, ReactNode> = {
  pdf: <FileText size={16} />,
  musicxml: <FileMusic size={16} />,
  midi: <Music2 size={16} />,
}

function ExportMenu({ score }: { score: Score | null }) {
  const t = useT()
  const model = useChordModel()
  const busy = useScoreExport((s) => s.busy)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={setBtn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tour="score.export"
        onClick={() => setOpen((v) => !v)}
        disabled={!score && !busy}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg shadow-[0_1px_0_rgb(255_255_255/0.2)_inset] hover:brightness-105 disabled:opacity-40"
      >
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />}
        <span className="hidden sm:inline">{t('score.export')}</span>
      </button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} placement="bottom-end" role="menu" ariaLabel={t('score.export')} className="w-72 p-1.5">
        {EXPORT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            disabled={!!busy}
            onClick={() => {
              setOpen(false)
              void exportScore(kind, model, score)
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-3 disabled:opacity-50"
          >
            <span className="mt-0.5 text-muted">{busy === kind ? <LoaderCircle size={16} className="animate-spin" /> : KIND_ICON[kind]}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(`score.export.${kind}`)}</span>
              <span className="block text-xs text-muted">{t(`score.export.${kind}.hint`)}</span>
            </span>
          </button>
        ))}
      </Floating>
    </>
  )
}

// ------------------------------------------------------------------ the notation

type Phase = 'lib' | 'drawing' | 'ready' | 'error'

/** Keeps the playing system comfortably in view (below the sticky toolbar, above ~65 % of the screen). */
function keepInView(wrap: HTMLElement, top: number, bottom: number): void {
  const r = wrap.getBoundingClientRect()
  const bar = document.querySelector('[data-cw-toolbar]')?.getBoundingClientRect()
  const minY = (bar?.bottom ?? 0) + 12
  const maxY = window.innerHeight * 0.68
  const y0 = r.top + top
  const y1 = r.top + bottom
  if (y0 >= minY && y1 <= maxY) return
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollBy({ top: y0 - minY - Math.max(0, (maxY - minY - (y1 - y0)) * 0.25), behavior: smooth ? 'smooth' : 'auto' })
}

function ScoreCanvas({ xml, score }: { xml: string; score: Score }) {
  const t = useT()
  const wrap = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const osmd = useRef<{ instance: OpenSheetMusicDisplay; theme: string } | null>(null)
  const layout = useRef<ScoreLayout | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const loaded = useRef<string | null>(null)
  const loadedTheme = useRef<string | null>(null)
  const [phase, setPhase] = useState<Phase>('lib')
  // the Score tour's canvas step only once the notes are drawn
  useTourFlags({ scoreRendered: phase === 'ready' })
  const [version, setVersion] = useState(0)
  const theme = useTheme()
  const width = useWidth(wrap)
  const narrow = width > 0 && width < 520
  const shownXml = useMemo(() => (narrow ? shortNames(xml) : xml), [xml, narrow])
  const follow = useApp((s) => s.follow)
  const followPaused = useChordUi((s) => s.followPaused)
  const lastSystem = useRef(-1)

  const relayout = useCallback(() => {
    const o = osmd.current?.instance
    const w = wrap.current
    const svg = host.current?.querySelector('svg')
    if (!o || !w || !svg) return
    const wr = w.getBoundingClientRect()
    const sr = svg.getBoundingClientRect()
    layout.current = measureLayout(o, score.map, { x: sr.left - wr.left, y: sr.top - wr.top })
    lastSystem.current = -1
    setVersion((v) => v + 1)
  }, [score])

  // load + draw whenever the MusicXML or the theme changes (one OSMD operation at a time)
  useEffect(() => {
    let cancelled = false
    queue.current = queue.current.then(async () => {
      if (cancelled || !host.current) return
      setPhase((p) => (p === 'lib' ? 'lib' : 'drawing'))
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      try {
        const colors = SCORE_COLORS[theme]
        if (!osmd.current || osmd.current.theme !== theme) {
          // real ♭ / ♯ in chord symbols and the same text font as the PDF (else the system serif)
          const font = (await registerScoreFont()) ? SCORE_FONT : FALLBACK_FONT
          if (cancelled || !host.current) return
          host.current.innerHTML = ''
          const instance = new OpenSheetMusicDisplay(host.current, {
            ...baseOptions(colors),
            drawTitle: false,
            drawSubtitle: false,
            drawComposer: false,
            drawCredits: false,
            defaultFontFamily: font,
          })
          instance.setLogLevel('warn')
          configureRules(instance, colors)
          osmd.current = { instance, theme }
        }
        const o = osmd.current.instance
        // the same notation again (e.g. another option that does not change the score): just re-measure
        if (loaded.current !== shownXml || osmd.current.theme !== loadedTheme.current) {
          await o.load(shownXml)
          if (cancelled) return
          o.Zoom = zoomFor(host.current.clientWidth)
          o.render()
          loaded.current = shownXml
          loadedTheme.current = theme
        }
        if (cancelled) return
        relayout()
        setPhase('ready')
      } catch (err) {
        console.warn('[score] rendering failed:', err)
        if (!cancelled) setPhase('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [shownXml, theme, relayout])

  // re-flow on width changes (debounced)
  const drawnWidth = useRef(0)
  useEffect(() => {
    if (!width || phase !== 'ready') return
    if (!drawnWidth.current) {
      drawnWidth.current = width
      return
    }
    if (Math.abs(width - drawnWidth.current) < 4) return
    const id = window.setTimeout(() => {
      queue.current = queue.current.then(() => {
        const o = osmd.current?.instance
        if (!o || !host.current) return
        drawnWidth.current = width
        o.Zoom = zoomFor(host.current.clientWidth)
        o.render()
        relayout()
      })
    }, 200)
    return () => window.clearTimeout(id)
  }, [width, phase, relayout])

  // the playback cursor (no re-render per frame)
  useClockEffect(
    (time) => {
      const c = cursor.current
      const b = bar.current
      const l = layout.current
      if (!c || !b) return
      const map = score.map
      const tick = map.toTicks(time)
      const mi = map.measureAtTick(tick)
      const m = map.measures[mi]
      const box = l?.measures[mi]
      if (!m || !box || tick < 0 || tick > map.totalTicks) {
        c.style.opacity = '0'
        b.style.opacity = '0'
        return
      }
      const x = xAt(box, (tick - m.offset) / m.ticks)
      c.style.opacity = '1'
      c.style.transform = `translate3d(${x - 1}px, ${box.top}px, 0)`
      c.style.height = `${box.bottom - box.top}px`
      b.style.opacity = '1'
      b.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`
      b.style.width = `${box.right - box.left}px`
      b.style.height = `${box.bottom - box.top}px`
      const app = useApp.getState()
      if (app.isPlaying && app.follow && !useChordUi.getState().followPaused && wrap.current && box.top !== lastSystem.current) {
        lastSystem.current = box.top
        keepInView(wrap.current, box.top, box.bottom)
      }
    },
    [score, version],
  )

  // following resumes: bring the current system back
  useEffect(() => {
    if (follow && !followPaused) lastSystem.current = -1
  }, [follow, followPaused])

  // manual scrolling pauses following until "back to playback" (like the chord sheet)
  useEffect(() => {
    if (!follow) return
    const pause = () => useChordUi.getState().setFollowPaused(true)
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) pause()
    }
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key) && !isTypingTarget(e.target)) pause()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchmove', pause, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchmove', pause)
      window.removeEventListener('keydown', onKey)
    }
  }, [follow])

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const w = wrap.current
      const l = layout.current
      if (!w || !l) return
      const r = w.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      const box = l.measures.find((b) => b && y >= b.top && y <= b.bottom && x >= b.left && x <= b.right)
      if (!box) return
      const m = score.map.measures[box.index]
      const tick = m.offset + fracAt(box, x) * m.ticks
      useApp.getState().seek(Math.max(0, score.map.toSeconds(tick)))
      useChordUi.getState().setFollowPaused(false)
    },
    [score],
  )

  const parts = useMemo(() => score.parts.map((p) => p.name).join(', '), [score])
  return (
    <div className="relative px-1 pt-2 pb-4 sm:px-3">
      <div
        ref={wrap}
        role="img"
        data-tour="score.canvas"
        aria-label={`${t('score.label')}: ${parts}. ${t('score.seekHint')}`}
        title={phase === 'ready' ? t('score.seekHint') : undefined}
        onClick={onClick}
        className={clsx('cw-score relative min-h-[240px] cursor-pointer select-none', phase !== 'ready' && 'pointer-events-none')}
      >
        <div ref={bar} aria-hidden className="pointer-events-none absolute top-0 left-0 rounded-md bg-accent/[0.08] opacity-0" />
        <div ref={host} />
        <div
          ref={cursor}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 w-[2px] rounded-full bg-accent opacity-0 shadow-[0_0_10px_rgb(255_181_71/0.55)]"
        />
      </div>
      {phase !== 'ready' && (
        <div className="absolute inset-0 flex items-start justify-center pt-16">
          <p
            className={clsx(
              'inline-flex items-center gap-2 rounded-xl bg-surface/90 px-3 py-2 text-sm backdrop-blur-sm',
              phase === 'error' ? 'text-danger' : 'text-muted',
            )}
          >
            {phase !== 'error' && <LoaderCircle size={15} className="animate-spin" aria-hidden />}
            {phase === 'lib' ? t('score.render.drawing') : phase === 'drawing' ? t('score.render.drawing') : t('score.render.failed')}
          </p>
        </div>
      )}
    </div>
  )
}

