import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type VideoMode = 'float' | 'dock'

interface PlayerUiState {
  /** floating mini window, or docked (right column on desktop, top strip on phones) */
  videoMode: VideoMode
  /** tracks whose YouTube video refused to embed (session only) */
  blocked: Record<string, true>
  /** measured height of the fixed bottom player bar */
  barHeight: number
  setVideoMode(mode: VideoMode): void
  markBlocked(trackId: string): void
  setBarHeight(h: number): void
}

export const usePlayerUi = create<PlayerUiState>()(
  persist(
    (set) => ({
      videoMode: 'float',
      blocked: {},
      barHeight: 0,
      setVideoMode: (videoMode) => set({ videoMode }),
      markBlocked: (id) => set((s) => ({ blocked: { ...s.blocked, [id]: true } })),
      setBarHeight: (barHeight) => set({ barHeight }),
    }),
    {
      name: 'chords-listener-player-ui',
      version: 1,
      partialize: (s) => ({ videoMode: s.videoMode }),
    },
  ),
)
