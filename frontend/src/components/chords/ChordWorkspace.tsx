// Chord workspace for the loaded track: now-playing hero, sticky toolbar, sheet, timeline or score
// (sheet music), chord legend, popover / editor and floating helpers. No props — everything comes from
// the store.

import { useEffect, useRef, useState } from 'react'
import { AudioWaveform } from 'lucide-react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import type { Track } from '../../types'
import './chords.css'
import { ChordLegend } from './ChordLegend'
import { ChordPopoverHost } from './ChordPopover'
import { useChordHotkeys } from './hotkeys'
import { ChordModelContext, useBuildChordModel } from './model'
import { NowPlaying } from './NowPlaying'
import { Overlays } from './Overlays'
import { LivePianoSlot } from './piano/LivePianoSlot'
import { ScoreSlot } from './score/ScoreSlot'
import { SheetView } from './SheetView'
import { TimelineView } from './TimelineView'
import { Toolbar } from './Toolbar'
import { useChordUi } from './uiStore'

export function ChordWorkspace() {
  const t = useT()
  const track = useApp((s) => s.track)
  if (!track) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center text-muted">
        <AudioWaveform size={28} className="text-faint" />
        <p>{t('chords.empty.noTrack')}</p>
      </div>
    )
  }
  return <Workspace track={track} />
}

/** True while at least a quarter of the element is visible below the sticky toolbar. */
function useMostlyVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setVisible(e.intersectionRatio > 0.25), {
      threshold: [0, 0.25, 0.5],
      rootMargin: '-64px 0px 0px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return visible
}

function Workspace({ track }: { track: Track }) {
  const t = useT()
  const model = useBuildChordModel(track)
  const view = useApp((s) => s.view)
  const hero = useRef<HTMLElement>(null)
  const heroVisible = useMostlyVisible(hero)
  useChordHotkeys(model)

  useEffect(() => {
    useChordUi.getState().reset()
  }, [track.id])

  return (
    <ChordModelContext value={model}>
      <div className="mx-auto w-full max-w-[1180px] px-4 pt-4 pb-[calc(var(--chords-bottom-offset,96px)+48px)] sm:px-6 sm:pt-6">
        <NowPlaying ref={hero} />
        <LivePianoSlot />
        <div className="h-3" />
        <Toolbar heroVisible={heroVisible} />
        <div className="mt-5 mb-10">
          {view === 'score' ? (
            <ScoreSlot />
          ) : model.hasChords ? (
            view === 'timeline' ? <TimelineView /> : <SheetView />
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-6 py-16 text-center">
              <AudioWaveform size={26} className="text-faint" />
              <p className="font-medium">{t('chords.empty.noChords')}</p>
              <p className="max-w-sm text-sm text-muted">{t('chords.empty.noChordsHint')}</p>
            </div>
          )}
        </div>
        <ChordLegend />
      </div>
      <ChordPopoverHost />
      <Overlays />
    </ChordModelContext>
  )
}
