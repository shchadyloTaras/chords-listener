// The DOM side of the tour that the store and the auto-start need: which anchors are on screen, and what on
// the page holds an automatic start back (an open dialog, menu or panel, typing, a hidden page).
import { isTypingTarget, modalOpen } from '../../hooks/useHotkeys'

/** The first rendered `data-tour="<id>"` (a copy hidden for the other breakpoint has no boxes). */
export function anchorElement(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)) {
    if (el.getClientRects().length > 0) return el
  }
  return null
}

export function anchorPresent(id: string): boolean {
  return anchorElement(id) !== null
}

/**
 * Focus is in a text field that has text. An empty field does not count: the home link field is autofocused
 * on desktops and would otherwise hold the Home tour back forever.
 */
export function typingNow(): boolean {
  const el = document.activeElement
  if (!isTypingTarget(el)) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== ''
  return true
}

export interface DomBlockers {
  modal: boolean
  menu: boolean
  expanded: boolean
  typing: boolean
  hidden: boolean
}

export function domBlockers(): DomBlockers {
  return {
    modal: modalOpen(),
    menu: document.querySelector('[role="menu"]') !== null,
    expanded: document.querySelector('[aria-expanded="true"]') !== null,
    typing: typingNow(),
    hidden: document.visibilityState === 'hidden',
  }
}

/** Runs once no aria-modal dialog is in the page (a closing Modal keeps it for its exit animation), ≤ 2 s. */
export function whenNoModal(run: () => void, tries = 40): void {
  if (tries <= 0 || !modalOpen()) return run()
  window.setTimeout(() => whenNoModal(run, tries - 1), 50)
}
