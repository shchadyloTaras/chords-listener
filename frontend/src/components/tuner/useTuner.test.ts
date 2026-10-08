// @vitest-environment jsdom
// The tuner loop with a fake microphone and manual animation frames: it shows a held note, waits while
// paused, reports refusals, and always lets the microphone go (stop, leaving, a late grant, unplugging).
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureError, captureMicrophone } from '../../lib/live'
import { FRAME_SIZE, startTuner, type TunerInput } from '../../lib/tuner/session'
import { useTuner } from './useTuner'

vi.mock('../../lib/live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/live')>()),
  captureMicrophone: vi.fn(),
}))
vi.mock('../../lib/tuner/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tuner/session')>()),
  startTuner: vi.fn(),
}))

const SR = 48000
const A4_FRAME = Float32Array.from({ length: FRAME_SIZE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR))

function fakeMic() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() })
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  return { track, stream }
}
function fakeInput() {
  const read = vi.fn((into: Float32Array) => {
    into.set(A4_FRAME)
    return 0.35
  })
  return { sampleRate: SR, read, stop: vi.fn() } satisfies TunerInput
}

let frames: FrameRequestCallback[] = []
let clock = 0
/** runs the queued animation frames n times */
const step = (n = 1) =>
  act(() => {
    for (let i = 0; i < n; i++) {
      const due = frames
      frames = []
      clock += 16
      due.forEach((cb) => cb(clock))
    }
  })

let root: Root
/** what the hook returned on the latest render */
const seen = {} as { hook: ReturnType<typeof useTuner> }
function Probe({ paused = false }: { paused?: boolean }) {
  const hook = useTuner({ a4: 440, paused })
  useEffect(() => {
    seen.hook = hook
  })
  return null
}
const render = (paused = false) => act(() => root.render(createElement(Probe, { paused })))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  frames = []
  clock = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  vi.mocked(captureMicrophone).mockReset()
  vi.mocked(startTuner).mockReset()
})

describe('useTuner', () => {
  it('starts on start() and shows a note once it has held for a few frames', async () => {
    const mic = fakeMic()
    const input = fakeInput()
    vi.mocked(captureMicrophone).mockResolvedValue(mic.stream)
    vi.mocked(startTuner).mockReturnValue(input)
    await render()
    await act(() => seen.hook.start())
    expect(seen.hook.state).toEqual({ phase: 'running', reading: null })
    step(3)
    expect(seen.hook.state).toMatchObject({ phase: 'running', reading: { midi: 69, cents: 0 } })
    expect(seen.hook.lastMidi).toBe(69)
  })

  it('does not listen while paused', async () => {
    vi.mocked(captureMicrophone).mockResolvedValue(fakeMic().stream)
    const input = fakeInput()
    vi.mocked(startTuner).mockReturnValue(input)
    await render(true)
    await act(() => seen.hook.start())
    step(5)
    expect(input.read).not.toHaveBeenCalled()
    expect(seen.hook.state).toEqual({ phase: 'running', reading: null })
  })

  it('a refused microphone is an error with its code', async () => {
    vi.mocked(captureMicrophone).mockRejectedValue(new CaptureError('denied'))
    await render()
    await act(() => seen.hook.start())
    expect(seen.hook.state).toEqual({ phase: 'error', code: 'denied', detail: null })
  })

  it('stop() while the browser asks releases the microphone granted afterwards', async () => {
    const mic = fakeMic()
    let grant!: (s: MediaStream) => void
    vi.mocked(captureMicrophone).mockReturnValue(new Promise((r) => (grant = r)))
    await render()
    let started!: Promise<void>
    act(() => {
      started = seen.hook.start()
    })
    expect(seen.hook.state).toEqual({ phase: 'starting' })
    act(() => seen.hook.stop())
    await act(async () => {
      grant(mic.stream)
      await started
    })
    expect(mic.track.stop).toHaveBeenCalled()
    expect(startTuner).not.toHaveBeenCalled()
    expect(seen.hook.state).toEqual({ phase: 'idle' })
  })

  it('leaving the page stops the microphone', async () => {
    vi.mocked(captureMicrophone).mockResolvedValue(fakeMic().stream)
    const input = fakeInput()
    vi.mocked(startTuner).mockReturnValue(input)
    await render()
    await act(() => seen.hook.start())
    act(() => root.unmount())
    expect(input.stop).toHaveBeenCalled()
    root = createRoot(document.createElement('div'))
  })

  it('a microphone that goes away ends with an error and is released', async () => {
    const mic = fakeMic()
    vi.mocked(captureMicrophone).mockResolvedValue(mic.stream)
    const input = fakeInput()
    vi.mocked(startTuner).mockReturnValue(input)
    await render()
    await act(() => seen.hook.start())
    act(() => {
      mic.track.dispatchEvent(new Event('ended'))
    })
    expect(input.stop).toHaveBeenCalled()
    expect(seen.hook.state).toEqual({ phase: 'error', code: 'ended', detail: null })
  })
})
