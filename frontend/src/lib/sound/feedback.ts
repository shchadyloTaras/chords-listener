// A brief "pressed / ringing" look on the element that started a chord sound. Web Animations
// only: no React state, nothing left behind, restarts cleanly on repeated clicks.

export type RingStyle = 'ring' | 'glow' | 'none'

const ID = 'cw-sound-ring'

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const tint = (color: string, pct: number) => `color-mix(in oklch, ${color} ${pct}%, transparent)`

/**
 * `ring`: a quick press (scale) and a ring in the chord colour that spreads and fades, like a sound
 * wave (chord blocks, tiles, buttons). `glow`: a soft halo around the glyphs (big chord names).
 * With reduced motion only the colour fades, nothing moves.
 */
export function ringElement(el: Element | null | undefined, color = 'var(--accent)', style: RingStyle = 'ring'): void {
  if (!el || style === 'none' || typeof (el as HTMLElement).animate !== 'function') return
  const reduce = reducedMotion()
  try {
    for (const a of el.getAnimations?.() ?? []) if (a.id === ID) a.cancel()
    let frames: Keyframe[]
    if (style === 'glow') {
      frames = [
        { filter: `drop-shadow(0 0 0 ${tint(color, 0)})`, transform: reduce ? 'none' : 'scale(0.985)' },
        { filter: `drop-shadow(0 0 14px ${tint(color, 70)})`, transform: 'none', offset: 0.22 },
        { filter: `drop-shadow(0 0 0 ${tint(color, 0)})`, transform: 'none' },
      ]
    } else if (reduce) {
      frames = [{ boxShadow: `0 0 0 2px ${tint(color, 80)}` }, { boxShadow: `0 0 0 2px ${tint(color, 0)}` }]
    } else {
      frames = [
        { boxShadow: `0 0 0 0 ${tint(color, 70)}`, transform: 'scale(0.965)' },
        { boxShadow: `0 0 0 3px ${tint(color, 50)}`, transform: 'none', offset: 0.28 },
        { boxShadow: `0 0 0 10px ${tint(color, 0)}`, transform: 'none' },
      ]
    }
    const anim = el.animate(frames, { duration: style === 'glow' ? 700 : 560, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' })
    anim.id = ID
  } catch {
    // keyframe values the browser cannot animate: no feedback, no error
  }
}
