// "Download the score" (score view header and the toolbar's copy / download menu): PDF for reading and
// printing on any device, MusicXML for notation editors, MIDI for DAWs. The score is the one shown in
// the score view (same parts / chords / notation level); started elsewhere, the notes are loaded (or
// transcribed, except at the simple level) first.

import { create } from 'zustand'
import { translate } from '../../../i18n'
import { isIOS, openBlob, saveBlob, scoreFileName } from '../../../lib/score/download'
import { toMidi } from '../../../lib/score/midi'
import { toMusicXml } from '../../../lib/score/musicxml'
import type { Score } from '../../../lib/score/types'
import { useApp } from '../../../store'
import type { ChordModel } from '../model'
import { prepareScore } from './scoreData'

export type ExportKind = 'pdf' | 'musicxml' | 'midi'

export const EXPORT_KINDS: readonly ExportKind[] = ['pdf', 'musicxml', 'midi']

/** The export in progress (one at a time), for spinners. */
export const useScoreExport = create<{ busy: ExportKind | null }>(() => ({ busy: null }))

const EXT: Record<ExportKind, string> = { pdf: 'pdf', musicxml: 'musicxml', midi: 'mid' }
const MIME: Record<ExportKind, string> = {
  pdf: 'application/pdf',
  musicxml: 'application/vnd.recordare.musicxml+xml',
  midi: 'audio/midi',
}

function details(score: Score, lang: 'uk' | 'en'): string {
  const parts: string[] = []
  if (score.meta.keyName) parts.push(translate(lang, 'score.pdf.key', { key: score.meta.keyName.replace(/#/g, '♯').replace(/(?<=[A-G])b/g, '♭') }))
  if (score.meta.tempo) parts.push(translate(lang, 'score.pdf.tempo', { bpm: score.meta.tempo }))
  return parts.join(' · ')
}

async function render(kind: ExportKind, score: Score, lang: 'uk' | 'en'): Promise<Blob> {
  if (kind === 'musicxml') return new Blob([toMusicXml(score)], { type: MIME.musicxml })
  if (kind === 'midi') {
    const bytes = toMidi(score)
    return new Blob([bytes.buffer as ArrayBuffer], { type: MIME.midi })
  }
  const { scorePdf } = await import('../../../lib/score/pdf')
  return scorePdf(toMusicXml(score), {
    title: score.meta.title,
    artist: score.meta.artist,
    details: details(score, lang),
    pageLabel: (n, total) => translate(lang, 'score.pdf.page', { n, total }),
    subject: translate(lang, 'score.pdf.subject'),
    creator: 'Chords Listener',
    lang,
  })
}

/**
 * Builds and saves the file. `score` = what the score view shows; without it the notes are prepared
 * here first (may transcribe the instruments, never starts a vocal job).
 */
export async function exportScore(kind: ExportKind, model: ChordModel, score?: Score | null): Promise<void> {
  if (useScoreExport.getState().busy) return
  const app = useApp.getState()
  const lang = app.lang
  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars)
  useScoreExport.setState({ busy: kind })
  try {
    let s = score ?? null
    if (!s) {
      let told = false
      s = await prepareScore(model, () => {
        if (!told) app.toast(t('score.export.preparing'), 'info')
        told = true
      })
    }
    if (!s) {
      app.toast(t('score.export.noNotes'), 'error')
      return
    }
    if (kind === 'pdf') app.toast(t('score.export.pdfWorking'), 'info')
    const blob = await render(kind, s, lang)
    const name = scoreFileName(s.meta.title, t('score.file'), EXT[kind])
    const result = saveBlob(blob, name)
    if (result === 'blocked') app.toast(t('score.export.openHint'), 'info', { label: t('score.export.open'), run: () => openBlob(blob) })
    // iOS may hold back a download that was not started by a tap: offer one (it saves via the share sheet / Files)
    else if (isIOS()) app.toast(t('score.export.done', { name }), 'success', { label: t('score.export.open'), run: () => saveBlob(blob, name) })
    else app.toast(t('score.export.done', { name }), 'success')
  } catch (err) {
    console.warn('[score] export failed:', err)
    app.toast(t('score.export.failed'), 'error')
  } finally {
    useScoreExport.setState({ busy: null })
  }
}
