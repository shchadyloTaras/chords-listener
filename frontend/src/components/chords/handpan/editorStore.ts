// Open state of the "My handpan" editor dialog (opened from the hero hint or the settings menu).

import { create } from 'zustand'

interface HandpanEditorState {
  open: boolean
  show(): void
  hide(): void
}

export const useHandpanEditor = create<HandpanEditorState>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}))
