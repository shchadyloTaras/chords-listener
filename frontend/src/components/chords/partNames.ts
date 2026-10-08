// Song parts in the chord views: their names and renaming (kept per track on this device).

import type { SectionKind } from '../../lib/music/sections'
import { useApp } from '../../store'

type T = (key: string, vars?: Record<string, string | number>) => string

/** m:ss of a time in the song. */
export const partTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/** A part's name: "Приспів", "Частина B"; with `n` of `of` occurrences "Куплет 2". */
export function partName(t: T, kind: SectionKind, group: string, n?: number, of?: number): string {
  const base = kind === 'part' ? t('chords.section.part', { letter: group.replace('′', '’') }) : t(`chords.section.${kind}`)
  return n != null && of != null && of > 1 ? `${base} ${n}` : base
}

/** Renames a part (all its occurrences) for this track; null gives it back its detected name. */
export function setPartKind(trackId: string, key: string, kind: SectionKind | null): void {
  const all = useApp.getState().sectionKinds ?? {}
  const mine = { ...all[trackId] }
  if (kind) mine[key] = kind
  else delete mine[key]
  const next = { ...all }
  if (Object.keys(mine).length) next[trackId] = mine
  else delete next[trackId]
  useApp.getState().setSetting('sectionKinds', next)
}

