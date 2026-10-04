// What every synthesized note hands back to the engine.

export interface VoiceParts {
  /** per-note output: the node the engine pans, routes and fades out on retrigger */
  out: GainNode
  /** steady value of `out.gain` (the fade starts from it) */
  level: number
  /** every scheduled source, stopped early when the note is cut */
  sources: AudioScheduledSourceNode[]
  /** every node of the note, disconnected once it has finished */
  nodes: AudioNode[]
  /** context time when the last source stops */
  end: number
  /** seconds after the start when the note counts as released (the live note's `end`) */
  release: number
}

/** A start-to-stop gain node that also lists itself for cleanup. */
export function gainNode(ctx: BaseAudioContext, value: number, nodes: AudioNode[]): GainNode {
  const g = ctx.createGain()
  g.gain.value = value
  nodes.push(g)
  return g
}
