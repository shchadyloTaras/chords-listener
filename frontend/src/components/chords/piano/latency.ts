// Audio output latency of this device as Web Audio reports it (AudioContext.outputLatency +
// baseLatency), measured once. Shown in the sync popover as a hint: the song's clock does not need it
// — browsers report the media position that is being heard (they subtract the same device latency) —
// so it explains why a residual offset (e.g. Bluetooth) is the user's to set.

type Ctor = new (opts?: AudioContextOptions) => AudioContext

let measured: Promise<number | null> | null = null

/** ms, or null when the browser does not report it. Call from a user gesture (creates an AudioContext). */
export function measureOutputLatency(shared?: BaseAudioContext | null): Promise<number | null> {
  if (shared && 'outputLatency' in shared) {
    const ctx = shared as AudioContext
    const value = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000
    if (value > 0) return Promise.resolve(Math.round(value))
  }
  measured ??= (async () => {
    const C: Ctor | undefined =
      typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext)
    if (!C) return null
    let ctx: AudioContext | null = null
    try {
      ctx = new C({ latencyHint: 'interactive' })
      if (ctx.state !== 'running') await ctx.resume().catch(() => undefined)
      // outputLatency is filled in once audio is flowing
      await new Promise((r) => setTimeout(r, 150))
      const value = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000
      return value > 0 && Number.isFinite(value) ? Math.round(value) : null
    } catch {
      return null
    } finally {
      void ctx?.close().catch(() => undefined)
    }
  })()
  return measured
}
