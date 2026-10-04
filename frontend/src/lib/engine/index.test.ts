import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAnalysis } from './core/types.ts'
import { BrowserEngineError, analyzeInBrowser, isBrowserEngineSupported } from './index.ts'
import type { AnalyzeRequest, WorkerMessage } from './protocol.ts'

// ---- fakes for the browser APIs the main thread uses ------------------------------------

const RESULT: BrowserAnalysis = {
  duration: 2,
  tempo: 120,
  timeSignature: 4,
  beats: [0.5, 1, 1.5],
  downbeats: [0.5],
  chords: [{ start: 0, end: 2, label: 'C', root: 'C', quality: 'maj', bass: null, confidence: 0.9 }],
  key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0.8 },
  waveform: new Array(1200).fill(0.5),
  engine: 'test',
}

let decodedSeconds = 2

class FakeOfflineAudioContext {
  sampleRate: number
  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate
  }
  decodeAudioData(data: ArrayBuffer, ok?: (b: unknown) => void, fail?: (e: unknown) => void): Promise<unknown> {
    const bytes = new Uint8Array(data)
    if (bytes[0] !== 0x52) {
      const err = new DOMException('Unable to decode audio data', 'EncodingError')
      fail?.(err)
      return Promise.reject(err)
    }
    const n = Math.round(decodedSeconds * this.sampleRate)
    const left = new Float32Array(n).fill(0.5)
    const right = new Float32Array(n).fill(-0.25)
    const buf = {
      length: n,
      numberOfChannels: 2,
      sampleRate: this.sampleRate,
      duration: n / this.sampleRate,
      getChannelData: (c: number) => (c === 0 ? left : right),
    }
    ok?.(buf)
    return Promise.resolve(buf)
  }
}

type Mode = 'ok' | 'error' | 'crash' | 'hang'

class FakeWorker {
  static mode: Mode = 'ok'
  static instances: FakeWorker[] = []
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  request: AnalyzeRequest | null = null
  transfer: Transferable[] = []
  url: string
  options: WorkerOptions | undefined

  constructor(url: URL | string, options?: WorkerOptions) {
    this.url = String(url)
    this.options = options
    FakeWorker.instances.push(this)
  }

  postMessage(msg: AnalyzeRequest, transfer: Transferable[]): void {
    this.request = msg
    this.transfer = transfer
    const emit = (data: WorkerMessage) => setTimeout(() => !this.terminated && this.onmessage?.({ data } as MessageEvent<WorkerMessage>), 0)
    switch (FakeWorker.mode) {
      case 'ok':
        emit({ type: 'progress', fraction: 0.5, message: 'Computing chroma' })
        emit({ type: 'progress', fraction: 0.4, message: 'Computing chroma' }) // out of order: must stay monotonic
        emit({ type: 'result', analysis: RESULT })
        break
      case 'error':
        emit({ type: 'error', code: 'analysis_failed', message: 'chord analysis failed: boom' })
        break
      case 'crash':
        setTimeout(() => this.onerror?.({ message: 'SyntaxError', preventDefault() {} } as ErrorEvent), 0)
        break
      case 'hang':
        emit({ type: 'progress', fraction: 0.3, message: 'Computing chroma' })
        break
    }
  }

  terminate(): void {
    this.terminated = true
  }
}

const audioFile = () => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3])], { type: 'audio/wav' })

beforeEach(() => {
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  vi.stubGlobal('Worker', FakeWorker)
  FakeWorker.mode = 'ok'
  FakeWorker.instances = []
  decodedSeconds = 2
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('analyzeInBrowser', () => {
  it('decodes, downmixes, transfers the samples to a module worker and resolves with its result', async () => {
    const progress: [number, string][] = []
    const res = await analyzeInBrowser(audioFile(), (f, m) => progress.push([f, m]))
    expect(res).toEqual(RESULT)
    const w = FakeWorker.instances[0]
    expect(w.options?.type).toBe('module')
    expect(w.terminated).toBe(true)
    expect(w.request!.sampleRate).toBe(22050)
    expect(w.request!.duration).toBeCloseTo(2)
    expect(w.request!.samples[0]).toBeCloseTo(0.125) // (0.5 + -0.25) / 2
    expect(w.transfer).toEqual([w.request!.samples.buffer])
    expect(progress[0]).toEqual([0, 'Reading file'])
    expect(progress.map(([, m]) => m)).toContain('Decoding audio')
    progress.forEach(([f], i) => i > 0 && expect(f).toBeGreaterThanOrEqual(progress[i - 1][0]))
  })

  it('rejects undecodable input with unsupported_format', async () => {
    const err = await analyzeInBrowser(new Blob(['not audio'])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserEngineError)
    expect((err as BrowserEngineError).code).toBe('unsupported_format')
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('rejects empty files, too long audio and oversized files', async () => {
    await expect(analyzeInBrowser(new Blob([]))).rejects.toMatchObject({ code: 'unsupported_format' })
    decodedSeconds = 31 * 60
    await expect(analyzeInBrowser(audioFile())).rejects.toMatchObject({ code: 'too_long' })
    const huge = { size: 600 * 1024 * 1024, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as unknown as Blob
    await expect(analyzeInBrowser(huge)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('maps worker failures to BrowserEngineError', async () => {
    FakeWorker.mode = 'error'
    await expect(analyzeInBrowser(audioFile())).rejects.toMatchObject({ name: 'BrowserEngineError', code: 'analysis_failed' })
    FakeWorker.mode = 'crash'
    await expect(analyzeInBrowser(audioFile())).rejects.toMatchObject({ code: 'analysis_failed' })
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true)
  })

  it('aborts: terminates the worker and rejects with the signal reason', async () => {
    FakeWorker.mode = 'hang'
    const ac = new AbortController()
    const p = analyzeInBrowser(audioFile(), (_f, m) => m === 'Computing chroma' && ac.abort(), { signal: ac.signal })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })

  it('rejects at once for an already aborted signal', async () => {
    await expect(analyzeInBrowser(audioFile(), undefined, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('needs Web Audio and Workers', async () => {
    expect(isBrowserEngineSupported()).toBe(true)
    vi.stubGlobal('Worker', undefined)
    expect(isBrowserEngineSupported()).toBe(false)
    await expect(analyzeInBrowser(audioFile())).rejects.toMatchObject({ code: 'analysis_failed' })
  })
})
