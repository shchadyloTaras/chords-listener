// Play-along: the selected instrument accompanies the song in its own style (lib/sound/accompany.ts).
// The runtime plays the steps on the chord-sound engine in sync with the player the way the
// metronome clicks: a 25 ms ticker plans what falls within the next LOOKAHEAD seconds of the song on
// the audio clock (MetronomeScheduler: re-synced after a seek, a loop wrap or a speed change). The
// clock it plans on is the one being heard (the output timestamp), the player reports the position
// being heard, so a step is heard together with the recording's beat whatever the output latency.
// The beat grid itself may sit a few ms off the recording's attacks (it depends on the song): the
// playAlongOffsetMs setting moves the whole accompaniment earlier / later.
// The next seconds' notes are rendered ahead, one per tick, so none renders when it is due.

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Minus, Plus } from 'lucide-react'
import { useT } from '../../i18n'
import { getLoadedDb, loadChordDb } from '../../lib/diagrams/chordsDb'
import { isWind } from '../../lib/instruments'
import { accompanySteps, ALONG_OFFSET_STEP, clampAlongOffset, PLAY_ALONG_OFFSET_LIMIT, type AccompStep, type ChordNotesFn } from '../../lib/sound/accompany'
import { chordSoundNotes, PLAY_ALONG_MAX_VOLUME, soundEngine, type NoteEvent } from '../../lib/sound'
import { lowerBound, MetronomeScheduler } from '../../lib/tempo'
import { useApp, type Instrument } from '../../store'
import { IconButton } from '../ui/IconButton'
import { INSTRUMENT_ICON } from './instrumentIcons'
import { useChordModel } from './model'
import { createTicker, type Ticker } from './tempo/metronome'
import { usePulseGrid } from './tempo/usePulseGrid'
import { useChordUi } from './uiStore'

/** Steps are planned this far ahead of the song (s of audio time). */
const LOOKAHEAD = 0.3
/** Notes of the steps due within this many song seconds are rendered ahead. */
const PREPARE_AHEAD = 4


/** A step's notes at playback rate `rate`: a held harmonium chord / blown wind note lasts the same stretch of the song. */
function stepNotes(instrument: Instrument, step: AccompStep, rate: number): NoteEvent[] {
  if ((instrument !== 'harmonium' && !isWind(instrument)) || rate === 1) return step.notes
  return step.notes.map((n) => (n.hold != null ? { ...n, hold: n.hold / rate } : n))
}

class PlayAlongRuntime {
  private steps: AccompStep[] = []
  private times: number[] = []
  private instrument: Instrument = 'guitar'
  private readonly scheduler = new MetronomeScheduler({ lookahead: LOOKAHEAD })
  private ticker: Ticker | null = null
  private running = false
  private lastResume = 0

  /** What is being played along (development: window.__playAlong). */
  get plan(): { instrument: Instrument; steps: readonly AccompStep[]; running: boolean } {
    return { instrument: this.instrument, steps: this.steps, running: this.running }
  }

  setSteps(instrument: Instrument, steps: AccompStep[]): void {
    if (steps === this.steps && instrument === this.instrument) return
    this.steps = steps
    this.times = steps.map((s) => s.time)
    this.instrument = instrument
    this.scheduler.setGrid(this.times, [])
    soundEngine.cancelAccompaniment()
  }

  /** Starts / stops the ticker to match the store (play-along on + playing). */
  sync(): void {
    const s = useApp.getState()
    const want = s.playAlong && s.isPlaying && Boolean(s.controller)
    if (want && !this.running) {
      if (!soundEngine.unlock()) return
      this.ticker ??= createTicker(this.tick)
      this.running = true
      soundEngine.keepAwake(true)
      this.ticker.start()
      this.tick()
    } else if (!want && this.running) this.halt()
  }

  stop(): void {
    if (this.running) this.halt()
  }

  private halt(): void {
    this.running = false
    this.ticker?.stop()
    this.scheduler.reset()
    soundEngine.cancelAccompaniment()
    soundEngine.keepAwake(false)
  }

  private tick = (): void => {
    if (!this.running) return
    const clock = soundEngine.clock()
    if (!clock) return
    const s = useApp.getState()
    if (!clock.running && performance.now() - this.lastResume > 1000) {
      this.lastResume = performance.now()
      soundEngine.unlock()
    }
    let media = NaN
    try {
      media = s.controller ? s.controller.getTime() : NaN
    } catch {
      // player not ready
    }
    const rate = s.playbackRate
    // the offset: planned as if the song were that much earlier (positive = the instrument later);
    // a change is eased in by the scheduler like clock drift
    media -= (clampAlongOffset(s.playAlongOffsetMs) / 1000) * rate
    const loop = s.loop && s.loop.end > s.loop.start ? s.loop.end : null
    // plan on the clock of what is heard now: a step planned at context time `at` is heard when the
    // song is at its time
    const plan = this.scheduler.update({ enabled: clock.running, ctxTime: clock.heard, mediaTime: media, rate, loopEnd: loop })
    if (plan.cancel) soundEngine.cancelAccompaniment()
    for (const c of plan.clicks) {
      const step = this.steps[c.beat]
      soundEngine.scheduleAt({ instrument: this.instrument, label: step.label, cut: step.cut, notes: stepNotes(this.instrument, step, rate) }, c.at)
    }
    if (clock.running && Number.isFinite(media)) this.prepareAhead(media, rate)
  }

  /** Renders one not-yet-cached note of the steps due in the next PREPARE_AHEAD song seconds. */
  private prepareAhead(media: number, rate: number): void {
    const until = media + PREPARE_AHEAD * Math.max(1, rate)
    for (let i = lowerBound(this.times, media); i < this.steps.length && this.times[i] <= until; i++) {
      if (soundEngine.prepare(this.instrument, stepNotes(this.instrument, this.steps[i], rate))) return
    }
  }
}

/**
 * The diagrams' notes per chord label on `instrument`, memoized per label. `inputs` are what those
 * notes depend on besides the label (the handpan scale, the chosen voicings, the loaded shapes): a
 * new list means a new resolver.
 */
function chordNotesResolver(instrument: Instrument, inputs: readonly unknown[]): ChordNotesFn {
  const memo = new Map<string, NoteEvent[]>()
  void inputs
  return (label) => {
    let notes = memo.get(label)
    if (!notes) {
      const found = chordSoundNotes(label, instrument)
      notes = Array.isArray(found) ? found : []
      memo.set(label, notes)
    }
    return notes
  }
}

let runtime: PlayAlongRuntime | null = null
function getRuntime(): PlayAlongRuntime {
  if (runtime) return runtime
  runtime = new PlayAlongRuntime()
  if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __playAlong?: PlayAlongRuntime }).__playAlong = runtime
  return runtime
}

/** Plays the selected instrument along the song while the play-along is on (mounted with the chords). */
export function PlayAlongRuntimeHost() {
  const { chords } = useChordModel()
  const grid = usePulseGrid()
  const instrument = useApp((s) => s.instrument)
  const on = useApp((s) => s.playAlong)
  const handpanScale = useApp((s) => s.handpanScale)
  const handpanNotes = useApp((s) => s.handpanNotes)
  const voicings = useChordUi((s) => s.voicings)
  const fretted = instrument === 'guitar' || instrument === 'ukulele'
  // the guitar / ukulele shapes load on demand: the steps are built once they are there
  const [dbLoaded, setDbLoaded] = useState(0)
  useEffect(() => {
    if (!on || !fretted || getLoadedDb(instrument)) return
    let alive = true
    loadChordDb(instrument).then(
      () => alive && setDbLoaded((n) => n + 1),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [on, fretted, instrument])

  const notesFor = useMemo(
    () => chordNotesResolver(instrument, [handpanScale, handpanNotes, voicings, dbLoaded]),
    [instrument, handpanScale, handpanNotes, voicings, dbLoaded],
  )
  const steps = useMemo(() => {
    if (!on || (fretted && !getLoadedDb(instrument))) return []
    return accompanySteps(instrument, chords, grid, notesFor)
  }, [on, fretted, instrument, chords, grid, notesFor])

  useEffect(() => {
    getRuntime().setSteps(instrument, steps)
  }, [instrument, steps])

  useEffect(() => {
    const r = getRuntime()
    r.sync()
    const unsub = useApp.subscribe((s, p) => {
      if (s.playAlong !== p.playAlong || s.isPlaying !== p.isPlaying || s.controller !== p.controller) r.sync()
    })
    // Browsers only start audio inside a gesture: while the play-along is on, every click / key press
    // wakes the audio, so it runs by the time that press starts the song.
    const wake = () => {
      if (useApp.getState().playAlong) soundEngine.unlock()
    }
    window.addEventListener('click', wake, { capture: true })
    window.addEventListener('keydown', wake, { capture: true })
    return () => {
      unsub()
      window.removeEventListener('click', wake, { capture: true })
      window.removeEventListener('keydown', wake, { capture: true })
      r.stop()
    }
  }, [])
  return null
}

/** The play-along's own volume (0..200%), apart from the chord sound's. */
export function PlayAlongVolume({ className }: { className?: string }) {
  const t = useT()
  const volume = useApp((s) => s.playAlongVolume)
  const pct = Math.round(volume * 100)
  return (
    <div className={clsx('items-center gap-1.5', className)} title={t('sound.along.volume')}>
      <input
        type="range"
        min={0}
        max={PLAY_ALONG_MAX_VOLUME}
        step={0.05}
        value={volume}
        aria-label={t('sound.along.volume')}
        aria-valuetext={`${pct}%`}
        onChange={(e) => useApp.getState().setSetting('playAlongVolume', Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-accent"
      />
      <span className={clsx('w-9 shrink-0 text-right font-mono text-[11px] tabular-nums', volume > 1 ? 'text-accent' : 'text-muted')}>{pct}%</span>
    </div>
  )
}

const signedMs = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0')

/** The play-along offset: ±150 ms (positive = the instrument plays later), steppers and a reset. */
export function PlayAlongOffset() {
  const t = useT()
  const value = clampAlongOffset(useApp((s) => s.playAlongOffsetMs))
  const set = (ms: number) => useApp.getState().setSetting('playAlongOffsetMs', clampAlongOffset(ms))
  const step = 'grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-text'
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <button type="button" aria-label={t('sound.along.offset.earlier')} title={t('sound.along.offset.earlier')} onClick={() => set(value - ALONG_OFFSET_STEP)} className={step}>
          <Minus size={14} />
        </button>
        <input
          type="range"
          min={-PLAY_ALONG_OFFSET_LIMIT}
          max={PLAY_ALONG_OFFSET_LIMIT}
          step={ALONG_OFFSET_STEP}
          value={value}
          aria-label={t('sound.along.offset')}
          aria-valuetext={t('sound.along.offset.ms', { n: signedMs(value) })}
          onChange={(e) => set(Number(e.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-accent"
        />
        <button type="button" aria-label={t('sound.along.offset.later')} title={t('sound.along.offset.later')} onClick={() => set(value + ALONG_OFFSET_STEP)} className={step}>
          <Plus size={14} />
        </button>
        <span className={clsx('w-14 shrink-0 text-right font-mono text-[11px] tabular-nums', value ? 'text-accent' : 'text-muted')}>
          {t('sound.along.offset.ms', { n: signedMs(value) })}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{t('sound.along.offset.hint')}</span>
        <button
          type="button"
          onClick={() => set(0)}
          disabled={!value}
          className="shrink-0 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-text disabled:opacity-40"
        >
          {t('sound.along.offset.reset')}
        </button>
      </div>
    </div>
  )
}

/** Player-bar toggle: the selected instrument plays along with the song (its icon, its style); its volume beside it while on. */
export function PlayAlongToggle() {
  const t = useT()
  const on = useApp((s) => s.playAlong)
  const instrument = useApp((s) => s.instrument)
  const Icon = INSTRUMENT_ICON[instrument]
  const label = t('sound.along.title', { instrument: t(`chords.instrument.${instrument}`), style: t(`sound.along.style.${instrument}`) })
  return (
    <div className="flex items-center gap-1.5">
      <IconButton
        label={label}
        active={on}
        aria-pressed={on}
        onClick={() => {
          const next = !on
          if (next) soundEngine.unlock()
          useApp.getState().setSetting('playAlong', next)
        }}
      >
        <Icon className="size-[18px]" />
      </IconButton>
      {on && <PlayAlongVolume className="hidden w-[7.5rem] sm:flex" />}
    </div>
  )
}
