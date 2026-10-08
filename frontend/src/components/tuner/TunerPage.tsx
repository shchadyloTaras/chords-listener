// #/tuner — a chromatic tuner. «Почати» asks for the microphone; the dial shows the nearest note and how
// far off it is against an adjustable A4; the reference tone sounds a picked note (the tuner does not
// listen meanwhile, or it would hear the tone). Everything stops when the page is left.

import clsx from 'clsx'
import { ArrowLeft, LoaderCircle, Mic, RotateCcw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { navigate, paths } from '../../hooks/useRoute'
import { canCaptureMicrophone } from '../../lib/live'
import { clampA4, formatCents, formatHz, isInTune, noteHz, noteName, tunerSpelling } from '../../lib/tuner/notes'
import { clampToneMidi, createReferenceTone, TONE_HIGH, TONE_LOW, type ReferenceTone } from '../../lib/tuner/tone'
import { useApp } from '../../store'
import { CaptureErrorAlert } from '../capture/CaptureErrorAlert'
import { Button } from '../ui/IconButton'
import { A4Control } from './A4Control'
import { ReferenceToneControl } from './ReferenceToneControl'
import { TunerDial } from './TunerDial'
import { useTuner, type TunerErrorCode } from './useTuner'

/** The microphone cannot be asked for here at all: say why instead of offering «Почати». */
function unavailable(): 'insecure' | 'unsupported' | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  return canCaptureMicrophone() ? null : 'unsupported'
}

export function TunerPage() {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const a4 = clampA4(useApp((s) => s.tunerA4))
  const setSetting = useApp((s) => s.setSetting)
  const spelling = tunerSpelling(useApp((s) => s.accidentals))
  useDocumentTitle(t('tuner.title'))

  const [toneOn, setToneOn] = useState(false)
  const [toneMidi, setToneMidi] = useState<number | null>(null)
  const { state, lastMidi, start, stop } = useTuner({ a4, paused: toneOn })
  const toneRef = useRef<ReferenceTone | null>(null)

  // the picker starts at the last note heard, else A4
  const picked = clampToneMidi(toneMidi ?? lastMidi ?? 69)
  const pickedName = noteName(picked, spelling)
  // the sounding tone follows the picked note and A4
  useEffect(() => {
    if (toneOn) toneRef.current?.play(noteHz(picked, a4))
  }, [toneOn, picked, a4])
  // leaving the page silences it
  useEffect(() => () => toneRef.current?.dispose(), [])

  const toggleTone = () => {
    const tone = (toneRef.current ??= createReferenceTone())
    if (toneOn) tone.stop()
    else tone.play(noteHz(picked, a4)) // in the click: browsers start audio only on a gesture
    setToneOn(!toneOn)
  }

  const blocked = unavailable()
  const reading = state.phase === 'running' && !toneOn ? state.reading : null
  const shownMidi = toneOn ? picked : (reading?.midi ?? null)
  const shown = shownMidi === null ? null : noteName(shownMidi, spelling)
  const inTune = reading !== null && isInTune(reading.cents)
  const errorText = (code: TunerErrorCode) => (code === 'ended' ? t('tuner.error.ended') : t(`live.error.${code}`))

  let status: string
  if (toneOn) status = t('tuner.tone.sounding', { note: `${pickedName.name}${pickedName.octave}` })
  else if (reading) status = `${formatHz(reading.hz, lang)} ${t('tuner.hz')} · ${formatCents(reading.cents)} ${t('tuner.cents')}`
  else if (state.phase === 'running') status = t('tuner.playNote')
  else status = t('tuner.idle')

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">
      <Button
        variant="ghost"
        className="-ml-3"
        icon={<ArrowLeft className="size-4" />}
        onClick={() => {
          stop()
          navigate(paths.home())
        }}
      >
        {t('core.job.backHome')}
      </Button>

      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('tuner.title')}</h1>
      <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted sm:text-base">{t('tuner.subtitle')}</p>

      <div className="mt-8 flex flex-col items-center">
        <TunerDial
          cents={reading ? reading.cents : null}
          inTune={inTune}
          label={reading ? t('tuner.aria.dial', { note: `${shown!.name}${shown!.octave}`, cents: formatCents(reading.cents) }) : t('tuner.aria.noNote')}
        />
        <p
          className={clsx(
            'mt-1 font-display text-7xl leading-none font-semibold tracking-tight tabular-nums transition-colors',
            toneOn ? 'text-muted' : inTune ? 'text-success' : shown ? 'text-text' : 'text-faint',
          )}
        >
          {shown ? (
            <>
              {shown.name}
              <sub className="ml-0.5 align-baseline text-3xl font-medium text-muted">{shown.octave}</sub>
            </>
          ) : (
            '—'
          )}
        </p>
        <p className="mt-3 min-h-5 text-center font-mono text-sm text-muted tabular-nums">{status}</p>
      </div>

      <div className="mt-8 flex flex-col items-center gap-3">
        {blocked ? (
          <CaptureErrorAlert message={t(`live.error.${blocked}`)} detail={null} className="w-full max-w-md" />
        ) : (
          <>
            {state.phase === 'error' && <CaptureErrorAlert message={errorText(state.code)} detail={state.detail} className="w-full max-w-md" />}
            {state.phase === 'running' ? (
              <Button icon={<Square className="size-3.5" fill="currentColor" />} onClick={stop}>
                {t('tuner.stop')}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={state.phase === 'starting'}
                icon={
                  state.phase === 'starting' ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : state.phase === 'error' ? (
                    <RotateCcw className="size-4" />
                  ) : (
                    <Mic className="size-4" />
                  )
                }
                onClick={() => void start()}
                className="h-12 px-6 text-base"
              >
                {state.phase === 'error' ? t('tuner.retry') : t('tuner.start')}
              </Button>
            )}
            {state.phase === 'starting' && (
              <span aria-live="polite" className="text-sm text-muted">
                {t('tuner.requesting')}
              </span>
            )}
          </>
        )}
      </div>

      <div className="mx-auto mt-10 flex max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
        <A4Control value={a4} onChange={(hz) => setSetting('tunerA4', hz)} />
        <ReferenceToneControl
          note={`${pickedName.name}${pickedName.octave}`}
          playing={toneOn}
          canLower={picked > TONE_LOW}
          canRaise={picked < TONE_HIGH}
          onLower={() => setToneMidi(clampToneMidi(picked - 1))}
          onRaise={() => setToneMidi(clampToneMidi(picked + 1))}
          onToggle={toggleTone}
        />
        <p className="text-xs text-faint">{t('tuner.tone.hint')}</p>
      </div>
    </div>
  )
}
