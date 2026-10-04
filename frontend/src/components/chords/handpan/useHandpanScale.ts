// The handpan scale from persisted settings, shared by every diagram (one object per setting change
// so per-scale caches and React memo comparisons stay cheap).

import { resolveScale, type HandpanScale } from '../../../lib/handpan'
import { useApp } from '../../../store'

let last: { id: string; notes: readonly string[]; scale: HandpanScale } | null = null

export function scaleFor(id: string, notes: readonly string[]): HandpanScale {
  if (last && last.id === id && last.notes === notes) return last.scale
  const scale = resolveScale(id, notes)
  // keep the identity when the content did not change (e.g. a re-hydrated equal array)
  const same = last && last.scale.key === scale.key && last.scale.id === scale.id
  last = { id, notes, scale: same && last ? last.scale : scale }
  return last.scale
}

export function useHandpanScale(): HandpanScale {
  const id = useApp((s) => s.handpanScale)
  const notes = useApp((s) => s.handpanNotes)
  return scaleFor(id, notes)
}
