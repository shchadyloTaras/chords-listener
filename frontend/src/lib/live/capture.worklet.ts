// AudioWorklet processor (runs on the audio rendering thread): downmixes the captured stream to
// mono and sends ~2048-sample batches straight to the analysis worker over a MessagePort, so the
// main thread never touches the audio. Pausing stops the sending (session time freezes).
// Loaded with audioWorklet.addModule() from its own bundled chunk (see session.ts).
//
// Keep this file self-contained: no imports (it is bundled on its own and must not pull in
// anything that touches `window` / `self`, which do not exist in AudioWorkletGlobalScope).

/** AudioWorkletGlobalScope declarations (not in the DOM lib). */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

// mirrors WORKLET_NAME / WORKLET_BATCH in protocol.ts (no imports here)
const NAME = 'chords-live-capture'
const BATCH = 2048

type Control = { type: 'port'; port: MessagePort } | { type: 'pause' } | { type: 'resume' } | { type: 'end' }

class LiveCaptureProcessor extends AudioWorkletProcessor {
  private out: MessagePort | null = null
  private buf = new Float32Array(BATCH)
  private n = 0
  private paused = false
  private ended = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<Control>) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'port') this.out = msg.port
      else if (msg.type === 'pause') {
        this.send()
        this.paused = true
      } else if (msg.type === 'resume') this.paused = false
      else if (msg.type === 'end') {
        this.send()
        this.out?.postMessage({ type: 'end' })
        this.ended = true
      }
    }
  }

  private send(): void {
    if (!this.n || !this.out) return
    const chunk = this.buf.slice(0, this.n)
    this.n = 0
    this.out.postMessage({ type: 'pcm', samples: chunk }, [chunk.buffer])
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.ended) return false
    const input = inputs[0]
    if (this.paused || !this.out || !input || input.length === 0) return true
    const channels = input.length
    const len = input[0].length
    const scale = 1 / channels
    for (let i = 0; i < len; i++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += input[c][i]
      this.buf[this.n++] = s * scale
      if (this.n === BATCH) this.send()
    }
    return true
  }
}

registerProcessor(NAME, LiveCaptureProcessor)
