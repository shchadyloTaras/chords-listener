// Score view preferences (this device only): which parts and chord symbols are shown, the simplified
// notation, and the vocal overlay on the live piano.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScoreOptions } from '../../../lib/score/types'

export interface ScoreSettings extends ScoreOptions {
  /** live piano: sung notes drawn over the keyboard */
  liveVocals: boolean
}

interface ScoreSettingsState extends ScoreSettings {
  setScoreSetting<K extends keyof ScoreSettings>(key: K, value: ScoreSettings[K]): void
}

export const useScoreSettings = create<ScoreSettingsState>()(
  persist(
    (set) => ({
      vocals: true,
      piano: true,
      chords: true,
      simplified: false,
      liveVocals: true,
      setScoreSetting: (key, value) => set({ [key]: value } as Partial<ScoreSettingsState>),
    }),
    {
      name: 'chords-listener-score',
      version: 1,
      partialize: (s): ScoreSettings => ({
        vocals: s.vocals,
        piano: s.piano,
        chords: s.chords,
        simplified: s.simplified,
        liveVocals: s.liveVocals,
      }),
    },
  ),
)

export function scoreOptions(s: ScoreOptions): ScoreOptions {
  return { vocals: s.vocals, piano: s.piano, chords: s.chords, simplified: s.simplified }
}
