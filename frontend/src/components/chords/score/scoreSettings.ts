// Score view preferences (this device only): which parts and chord symbols are shown, the notation
// level, and the vocal overlay on the live piano.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { SCORE_LEVELS, type ScoreLevel, type ScoreOptions } from '../../../lib/score/types'

export interface ScoreSettings extends ScoreOptions {
  /** live piano: sung notes drawn over the keyboard */
  liveVocals: boolean
}

interface ScoreSettingsState extends ScoreSettings {
  setScoreSetting<K extends keyof ScoreSettings>(key: K, value: ScoreSettings[K]): void
}

const VERSION = 2

const isLevel = (v: unknown): v is ScoreLevel => SCORE_LEVELS.includes(v as ScoreLevel)

/**
 * A state stored by `version` as this version's settings. v1 had one «Спрощено» switch (`simplified`):
 * on = today's medium level, off = full. A level this build does not know (broken storage, a state
 * from a newer build) is full.
 */
export function migrateScoreSettings(persisted: unknown, version: number): Partial<ScoreSettings> {
  const state = persisted && typeof persisted === 'object' ? (persisted as Partial<ScoreSettings> & { simplified?: unknown }) : {}
  const { simplified, level, ...rest } = state
  if (version < 2) return { ...rest, level: simplified === true ? 'medium' : 'full' }
  return { ...rest, level: isLevel(level) ? level : 'full' }
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
      version: VERSION,
      migrate: (persisted, version) => migrateScoreSettings(persisted, version) as ScoreSettingsState,
      // a state of this version is checked too (migrate only runs for another version)
      merge: (persisted, current) => (persisted ? { ...current, ...migrateScoreSettings(persisted, VERSION) } : current),
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
