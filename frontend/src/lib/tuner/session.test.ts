// @vitest-environment jsdom
// The tuner's microphone graph against a fake Web Audio: window size, reading a frame, the iOS unlock,
// and a stop that releases the microphone exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureError } from '../live'
import { FRAME_SIZE, startTuner } from './session'

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  data = new Float32Array(FRAME_SIZE)
  getFloatTimeDomainData(into: Float32Array) {
    into.set(this.data.subarray(0, into.length))
  }
}
class FakeContext {
  static last: FakeContext
  static startState: AudioContextState = 'running'
  sampleRate = 48000
  state: AudioContextState = FakeContext.startState
  destination = {}
  analyser = new FakeAnalyser()
  source = new FakeNode()
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  constructor() {
    FakeContext.last = this
  }
  createMediaStreamSource() {
    return this.source
  }
  createAnalyser() {
    return this.analyser
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } })
  }
}

function fakeStream() {
  const track = { stop: vi.fn() }
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream }
}

beforeEach(() => {
  FakeContext.startState = 'running'
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => vi.unstubAllGlobals())

describe('startTuner', () => {
  it('reads FRAME_SIZE-sample windows with no smoothing, wired silently to the speakers', () => {
    const input = startTuner(fakeStream().stream)
    const ctx = FakeContext.last
    expect(input.sampleRate).toBe(48000)
    expect(ctx.analyser.fftSize).toBe(FRAME_SIZE)
    expect(ctx.analyser.smoothingTimeConstant).toBe(0)
    expect(ctx.source.connect).toHaveBeenCalledWith(ctx.analyser)
  })

  it('read() copies the newest window and returns its RMS', () => {
    const input = startTuner(fakeStream().stream)
    FakeContext.last.analyser.data.fill(0.5)
    const frame = new Float32Array(FRAME_SIZE)
    expect(input.read(frame)).toBeCloseTo(0.5, 6)
    expect(frame[FRAME_SIZE - 1]).toBe(0.5)
  })

  it('resumes a suspended context at once and on the next tap, not after stop', () => {
    FakeContext.startState = 'suspended'
    const input = startTuner(fakeStream().stream)
    const ctx = FakeContext.last
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    ctx.state = 'suspended' // iOS suspended it again
    window.dispatchEvent(new Event('pointerdown'))
    expect(ctx.resume).toHaveBeenCalledTimes(2)
    input.stop()
    ctx.state = 'suspended'
    window.dispatchEvent(new Event('pointerdown'))
    expect(ctx.resume).toHaveBeenCalledTimes(2)
  })

  it('stop() releases the microphone and closes the context once', () => {
    const { stream, track } = fakeStream()
    const input = startTuner(stream)
    input.stop()
    input.stop()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(FakeContext.last.source.disconnect).toHaveBeenCalledTimes(1)
    expect(FakeContext.last.close).toHaveBeenCalledTimes(1)
  })

  it('without Web Audio it fails as unsupported', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    expect(() => startTuner(fakeStream().stream)).toThrow(CaptureError)
    try {
      startTuner(fakeStream().stream)
    } catch (e) {
      expect((e as CaptureError).code).toBe('unsupported')
    }
  })
})
