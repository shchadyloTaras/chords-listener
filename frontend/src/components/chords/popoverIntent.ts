// Hover-intent timing for the chord popover, shared by sheet slots, timeline blocks and the host.

import { useChordUi, type PopoverState } from './uiStore'

const OPEN_DELAY = 380
const CLOSE_DELAY = 180
let openTimer = 0
let closeTimer = 0

/** Hover-intent helpers shared by sheet slots, timeline blocks and legend tiles. */
export const popoverIntent = {
  openSoon(p: PopoverState) {
    window.clearTimeout(closeTimer)
    window.clearTimeout(openTimer)
    const cur = useChordUi.getState().popover
    if (cur?.mode === 'edit') return
    if (cur) {
      useChordUi.getState().openPopover(p)
      return
    }
    openTimer = window.setTimeout(() => useChordUi.getState().openPopover(p), OPEN_DELAY)
  },
  openNow(p: PopoverState) {
    window.clearTimeout(closeTimer)
    window.clearTimeout(openTimer)
    useChordUi.getState().openPopover(p)
  },
  closeSoon() {
    window.clearTimeout(openTimer)
    window.clearTimeout(closeTimer)
    if (useChordUi.getState().popover?.mode === 'edit') return
    closeTimer = window.setTimeout(() => useChordUi.getState().closePopover(), CLOSE_DELAY)
  },
  keep() {
    window.clearTimeout(closeTimer)
  },
  cancel() {
    window.clearTimeout(openTimer)
  },
}
