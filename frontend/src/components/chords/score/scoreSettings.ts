// Score view preferences (this device only): which parts and chord symbols are shown, the notation
// level, and the vocal overlay on the live piano.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScoreLevel, ScoreOptions } from '../../../lib/score/types'

export interface ScoreSettings extends ScoreOptions {
  /** live piano: sung notes drawn over the keyboard */
  liveVocals: boolean
}

interface ScoreSettingsState extends ScoreSettings {
  setScoreSetting<K extends keyof ScoreSettings>(key: K, value: ScoreSettings[K]): void
}

/** v1 had one «Спрощено» switch (`simplified`): on = today's medium level, off = full. */
export function migrateScoreSettings(persisted: unknown, version: number): Partial<ScoreSettings> {
  const state = persisted && typeof persisted === 'object' ? (persisted as Partial<ScoreSettings> & { simplified?: unknown }) : {}
  if (version >= 2) return state
  const { simplified, ...rest } = state
  const level: ScoreLevel = simplified === true ? 'medium' : 'full'
  return { ...rest, level }
}

export const useScoreSettings = create<ScoreSettingsState>()(
  persist(
    (set) => ({
      vocals: true,
      piano: true,
      chords: true,
      level: 'full',
      liveVocals: true,
      setScoreSetting: (key, value) => set({ [key]: value } as Partial<ScoreSettingsState>),
    }),
    {
      name: 'chords-listener-score',
      version: 2,
      migrate: (persisted, version) => migrateScoreSettings(persisted, version) as ScoreSettingsState,
      partialize: (s): ScoreSettings => ({
        vocals: s.vocals,
        piano: s.piano,
        chords: s.chords,
        level: s.level,
        liveVocals: s.liveVocals,
      }),
    },
  ),
)

export function scoreOptions(s: ScoreOptions): ScoreOptions {
  return { vocals: s.vocals, piano: s.piano, chords: s.chords, level: s.level }
}
