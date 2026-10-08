// The reference tone against a fake Web Audio: a click-free start and stop, a glide between notes on the
// same oscillator, and nothing at all where Web Audio is missing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clampToneMidi, createReferenceTone, FADE_S, TONE_GAIN } from './tone'

class FakeParam {
  value = 0
  calls: string[] = []
  setValueAtTime(v: number, t: number) {
    this.calls.push(`set ${v} @${t}`)
    this.value = v
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(`ramp ${v} @${t}`)
  }
  setTargetAtTime(v: number, t: number) {
    this.calls.push(`target ${v} @${t}`)
  }
  cancelScheduledValues(t: number) {
    this.calls.push(`cancel @${t}`)
  }
}
class FakeOsc {
  type = ''
  frequency = new FakeParam()
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
class FakeGain {
  gain = new FakeParam()
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeContext {
  static made: FakeContext[] = []
  currentTime = 1
  state: AudioContextState = 'running'
  destination = {}
  oscs: FakeOsc[] = []
  gains: FakeGain[] = []
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  constructor() {
    FakeContext.made.push(this)
  }
  createOscillator() {
    const o = new FakeOsc()
    this.oscs.push(o)
    return o
  }
  createGain() {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
}

beforeEach(() => {
  FakeContext.made = []
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => vi.unstubAllGlobals())

describe('createReferenceTone', () => {
  it('starts a sine at the note, fading in from silence', () => {
    const tone = createReferenceTone()
    tone.play(440)
    const ctx = FakeContext.made[0]
    expect(ctx.oscs[0].type).toBe('sine')
    expect(ctx.oscs[0].frequency.calls).toEqual(['set 440 @1'])
    expect(ctx.gains[0].gain.calls).toEqual(['set 0 @1', `ramp ${TONE_GAIN} @${1 + FADE_S}`])
    expect(ctx.oscs[0].start).toHaveBeenCalledWith(1)
    expect(tone.playing).toBe(true)
  })

  it('glides the same oscillator to another note', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.play(466.16)
    const ctx = FakeContext.made[0]
    expect(ctx.oscs).toHaveLength(1)
    expect(ctx.oscs[0].frequency.calls[1]).toMatch(/^target 466.16 @1$/)
  })

  it('stops with a fade, then frees the nodes', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.stop()
    const ctx = FakeContext.made[0]
    expect(ctx.gains[0].gain.calls.at(-1)).toBe(`ramp 0 @${1 + FADE_S}`)
    expect(ctx.oscs[0].stop).toHaveBeenCalledWith(1 + FADE_S + 0.01)
    expect(tone.playing).toBe(false)
    ctx.oscs[0].onended?.()
    expect(ctx.oscs[0].disconnect).toHaveBeenCalled()
    expect(ctx.gains[0].disconnect).toHaveBeenCalled()
  })

  it('a new play after stop starts a fresh oscillator in the same context', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.stop()
    tone.play(220)
    expect(FakeContext.made).toHaveLength(1)
    expect(FakeContext.made[0].oscs).toHaveLength(2)
  })

  it('dispose stops the tone and closes the context', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.dispose()
    expect(tone.playing).toBe(false)
    expect(FakeContext.made[0].close).toHaveBeenCalledTimes(1)
  })

  it('does nothing without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    const tone = createReferenceTone()
    expect(() => tone.play(440)).not.toThrow()
    expect(tone.playing).toBe(false)
  })

  it('keeps the picker within C2..C6', () => {
    expect(clampToneMidi(28)).toBe(36)
    expect(clampToneMidi(69)).toBe(69)
    expect(clampToneMidi(96)).toBe(84)
  })
})
