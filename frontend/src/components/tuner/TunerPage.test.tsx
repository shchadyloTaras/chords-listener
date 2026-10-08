// @vitest-environment jsdom
// The tuner page with a stubbed loop and tone: the status line never contradicts the controls on screen, the
// reference tone pauses the tuner while it sounds, and leaving the page silences it.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReferenceTone, type ReferenceTone } from '../../lib/tuner/tone'
import { TunerPage } from './TunerPage'
import { useTuner, type TunerState } from './useTuner'

vi.mock('./useTuner', () => ({ useTuner: vi.fn() }))
vi.mock('../../lib/tuner/tone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tuner/tone')>()),
  createReferenceTone: vi.fn(),
}))

const IDLE_HINT = 'Натисни «Почати» й дозволь мікрофон'
const REQUESTING = 'Дозволь доступ до мікрофона…'
const TAP_HINT = 'Торкнися екрана, щоб тюнер почав слухати'

let root: Root
let host: HTMLDivElement
let tone: { play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; playing: boolean }

function stubTuner(state: TunerState, extra: { waitingForTap?: boolean } = {}) {
  vi.mocked(useTuner).mockReturnValue({
    state,
    lastMidi: null,
    waitingForTap: extra.waitingForTap ?? false,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  })
}
function withMicrophoneApi(on: boolean) {
  Object.defineProperty(navigator, 'mediaDevices', { value: on ? { getUserMedia: vi.fn() } : undefined, configurable: true })
}
const render = () => act(() => root.render(createElement(TunerPage)))
const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
const pausedArg = () => vi.mocked(useTuner).mock.calls.at(-1)![0].paused
const count = (needle: string) => text().split(needle).length - 1

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  tone = { play: vi.fn(), stop: vi.fn(), dispose: vi.fn(), playing: false }
  vi.mocked(createReferenceTone).mockReturnValue(tone as unknown as ReferenceTone)
  withMicrophoneApi(true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(useTuner).mockReset()
  withMicrophoneApi(false)
})

describe('status line', () => {
  it('idle: invites to press «Почати», which is there', () => {
    stubTuner({ phase: 'idle' })
    render()
    expect(text()).toContain(IDLE_HINT)
    expect(button('Почати')).toBeDefined()
  })

  it('no microphone API: says why, with no «Почати» and no invitation to press it', () => {
    withMicrophoneApi(false)
    stubTuner({ phase: 'idle' })
    render()
    expect(text()).toContain('Цей браузер так не вміє')
    expect(button('Почати')).toBeUndefined()
    expect(text()).not.toContain(IDLE_HINT)
  })

  it('starting: the permission line shows once', () => {
    stubTuner({ phase: 'starting' })
    render()
    expect(count(REQUESTING)).toBe(1)
    expect(text()).not.toContain(IDLE_HINT)
  })

  it('error: the alert and «Почати знову», no invitation to press «Почати»', () => {
    stubTuner({ phase: 'error', code: 'denied', detail: null })
    render()
    expect(text()).toContain('Доступ заборонено')
    expect(button('Почати знову')).toBeDefined()
    expect(text()).not.toContain(IDLE_HINT)
  })

  it('running while the audio waits for a tap: asks for the tap instead of a note', () => {
    stubTuner({ phase: 'running', reading: null }, { waitingForTap: true })
    render()
    expect(text()).toContain(TAP_HINT)
    expect(text()).not.toContain('Зіграй ноту')
  })
})

describe('reference tone', () => {
  it('«Грати» sounds A4 and pauses the tuner; «Стоп» stops it and resumes; the button names its action', () => {
    stubTuner({ phase: 'running', reading: null })
    render()
    expect(pausedArg()).toBe(false)
    act(() => button('Грати')!.click())
    expect(tone.play).toHaveBeenCalledWith(440)
    expect(pausedArg()).toBe(true)
    const toggle = button('Стоп')!
    expect(toggle.hasAttribute('aria-pressed')).toBe(false)
    act(() => toggle.click())
    expect(tone.stop).toHaveBeenCalledTimes(1)
    expect(pausedArg()).toBe(false)
    expect(button('Грати')).toBeDefined()
  })

  it('leaving the page while it sounds silences it', () => {
    stubTuner({ phase: 'idle' })
    render()
    act(() => button('Грати')!.click())
    act(() => root.unmount())
    expect(tone.dispose).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
