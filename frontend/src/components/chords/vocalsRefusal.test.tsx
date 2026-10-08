// @vitest-environment jsdom
// AC-18 / AC-26 / AC-28: when the administrator refuses a vocal transcription (restricted account, paused analyses,
// vocals off) the Score card and the live-keys line say so in the cloud's words (a restriction names the support
// e-mail) and show no retry — it would be refused again. A failure of any other kind keeps its retry.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() =>
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
)
vi.mock('./model', () => ({ useChordModel: () => ({ track: { id: 't1', duration: 100, source: { type: 'file' } } }) }))
vi.mock('../../lib/score/osmd', () => ({}))
vi.mock('../../lib/score/fonts', () => ({ FALLBACK_FONT: '', SCORE_FONT: '', registerScoreFont: vi.fn() }))
// retry is only ever offered where vocals work at all: make them work, so a missing retry is down to the refusal
vi.mock('../../lib/vocals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vocals')>()),
  vocalsSupport: () => 'ok',
}))
vi.mock('./piano/renderer', () => ({ PianoRenderer: class {} }))
vi.mock('./piano/SyncControl', () => ({ SyncControl: () => null }))
vi.mock('./score/pianoNotes', () => ({ usePianoNotes: () => ({ status: 'idle' }) }))

import { SUPPORT_EMAIL } from '../../i18n/cloud'
import { useApp } from '../../store'
import { VocalsLine } from './piano/LivePiano'
import { VocalsCard } from './score/ScoreView'
import type { VocalsState } from '../../lib/vocals'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'en' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const failed = (code: string): VocalsState => ({ status: 'error', code, message: 'raw server text', during: 'job' })
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent)

function card(state: VocalsState) {
  act(() => root.render(<VocalsCard state={state} />))
}
function line(state: VocalsState) {
  act(() => root.render(<VocalsLine ready offer chords={false} vocals={state} showVocals />))
}

describe.each([
  ['Score card', card],
  ['live keys line', line],
])('%s', (_name, show) => {
  it('restricted account: names the support e-mail, no retry', () => {
    show(failed('cloud_restricted'))
    expect(host.textContent).toContain(SUPPORT_EMAIL)
    expect(buttons()).toEqual([])
  })
  it('paused analyses: explained, no retry', () => {
    show(failed('analyses_paused'))
    expect(host.textContent).toMatch(/paused/i)
    expect(buttons()).toEqual([])
  })
  it('vocals switched off: explained, no retry', () => {
    show(failed('vocals_disabled'))
    expect(host.textContent).toMatch(/unavailable/i)
    expect(buttons()).toEqual([])
  })
  it('an ordinary failure keeps its retry', () => {
    show(failed('internal'))
    expect(buttons().length).toBe(1)
  })
})
