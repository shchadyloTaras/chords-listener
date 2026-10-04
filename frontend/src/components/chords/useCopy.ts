// Copy / download actions honoring transpose, simplify, accidentals, format and repeat folding.

import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { copyText, downloadText } from '../../lib/clipboard'
import { formatChordPro, formatChords, safeFileName, type ExportRange } from '../../lib/music/formats'
import { useApp, type CopyFormat } from '../../store'
import type { ChordModel } from './model'
import { useChordUi } from './uiStore'

/** Copies and toasts; resolves true on success. */
export async function copyWithToast(text: string, message: string): Promise<boolean> {
  const ok = await copyText(text)
  useApp.getState().toast(ok ? message : t('chords.toast.copyFailed'), ok ? 'success' : 'error')
  return ok
}

function input(model: ChordModel) {
  const s = useApp.getState()
  return model.exportInput(s.barsPerLine, useChordUi.getState().collapseRepeats)
}

export function copyAll(model: ChordModel, format: CopyFormat = useApp.getState().copyFormat): Promise<boolean> {
  return copyWithToast(formatChords(format, input(model)), t('chords.toast.copiedAll'))
}

export function copyBars(model: ChordModel, range: ExportRange): Promise<boolean> {
  const text = formatChords(useApp.getState().copyFormat, input(model), range)
  const from = range.fromBar + 1
  const to = range.toBar + 1
  const msg = from === to ? t('chords.toast.copiedBar', { n: from }) : t('chords.toast.copiedBars', { from, to })
  return copyWithToast(text, msg)
}

export function copyChordName(label: string): Promise<boolean> {
  return copyWithToast(label, t('chords.toast.copiedChord', { chord: label }))
}

export function downloadChords(model: ChordModel, kind: 'txt' | 'cho'): void {
  const s = useApp.getState()
  const inp = input(model)
  const format = s.copyFormat === 'chordpro' ? 'bars' : s.copyFormat
  const text = kind === 'cho' ? formatChordPro(inp) : formatChords(format, inp)
  const name = `${safeFileName(model.track.title)}.${kind}`
  downloadText(name, text, kind === 'cho' ? 'application/x-chordpro' : 'text/plain')
  s.toast(t('chords.download.done', { name }), 'success')
}

/** Inline ✓ feedback: `run` wraps an async copy; `done` is true for ~1.4 s after success. */
export function useCopyFeedback(): { done: boolean; run: (fn: () => Promise<boolean>) => void } {
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const run = useCallback((fn: () => Promise<boolean>) => {
    void fn().then((ok) => {
      if (!ok) return
      setDone(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setDone(false), 1400)
    })
  }, [])
  return { done, run }
}
