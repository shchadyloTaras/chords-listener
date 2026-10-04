// Workspace-local UI state (not persisted): hover highlight, bar selection, follow pause,
// the chord popover / editor, repeat folding, timeline zoom and per-chord voicing choice.

import { create } from 'zustand'

export interface BarSelection {
  anchor: number
  focus: number
}

export interface PopoverState {
  /** display chord index */
  chordIndex: number
  anchor: HTMLElement
  mode: 'info' | 'edit'
  /** seek target when "play from here" is used */
  time: number
}

interface ChordUiState {
  hoverLabel: string | null
  setHoverLabel(label: string | null): void

  selection: BarSelection | null
  selectBar(index: number, extend: boolean): void
  clearSelection(): void

  /** user scrolled away while following: auto-scroll waits until "back to playback" */
  followPaused: boolean
  setFollowPaused(paused: boolean): void

  popover: PopoverState | null
  openPopover(p: PopoverState): void
  closePopover(): void

  collapseRepeats: boolean
  setCollapseRepeats(v: boolean): void

  /** timeline pixels per second */
  zoom: number
  setZoom(z: number): void

  /** chosen voicing index per "instrument:label" */
  voicings: Record<string, number>
  setVoicing(key: string, index: number): void

  reset(): void
}

export const ZOOM_MIN = 8
export const ZOOM_MAX = 320
export const ZOOM_DEFAULT = 44

export const useChordUi = create<ChordUiState>()((set, get) => ({
  hoverLabel: null,
  setHoverLabel: (hoverLabel) => {
    if (get().hoverLabel !== hoverLabel) set({ hoverLabel })
  },

  selection: null,
  selectBar: (index, extend) => {
    const cur = get().selection
    if (extend && cur) set({ selection: { anchor: cur.anchor, focus: index } })
    else if (cur && cur.anchor === index && cur.focus === index) set({ selection: null })
    else set({ selection: { anchor: index, focus: index } })
  },
  clearSelection: () => set({ selection: null }),

  followPaused: false,
  setFollowPaused: (followPaused) => {
    if (get().followPaused !== followPaused) set({ followPaused })
  },

  popover: null,
  openPopover: (popover) => set({ popover }),
  closePopover: () => {
    if (get().popover) set({ popover: null })
  },

  collapseRepeats: false,
  setCollapseRepeats: (collapseRepeats) => set({ collapseRepeats }),

  zoom: ZOOM_DEFAULT,
  setZoom: (z) => set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) }),

  voicings: {},
  setVoicing: (key, index) => set({ voicings: { ...get().voicings, [key]: index } }),

  reset: () => set({ hoverLabel: null, selection: null, followPaused: false, popover: null }),
}))

export function selectionRange(sel: BarSelection | null): [number, number] | null {
  if (!sel) return null
  return sel.anchor <= sel.focus ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor]
}
