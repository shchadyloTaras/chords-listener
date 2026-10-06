// Where the tour's bubble goes and how far to scroll (spec §2 "Placement"), in viewport pixels. Desktop: below
// or above the spotlight, whichever fits, clamped to the viewport, never over the player bar or the floating
// video; a spotlight taller than the free area docks the bubble at its bottom. Docked (`dock`: phones, and short
// screens such as a phone in landscape, where neither side has room): the bubble always docks at the bottom,
// above the player bar, and the spotlight is scrolled above it. Pure; components/tour/geometry.ts measures the
// page and decides `dock`.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** The viewport; `top` = below the sticky header (and a stuck toolbar), `bottom` = above the player bar. */
export interface View {
  width: number
  height: number
  top: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export interface Placement {
  left: number
  top: number
  width: number
  /** the bubble scrolls inside beyond this */
  maxHeight: number
}

export const MARGIN = 8
/** between the cut-out and the bubble */
export const GAP = 12
/** cut-out padding around the spotlight */
export const PAD = 6
export const PHONE_GUTTER = 16
/** a docked bubble on a wide short screen stays readable */
export const DOCK_MAX_WIDTH = 640

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  }
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }
  return r.right > r.left && r.bottom > r.top ? r : null
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Scroll needed to show [start, end] inside [viewStart, viewEnd] ("nearest"; the start when it is too long). */
export function nearestDelta(start: number, end: number, viewStart: number, viewEnd: number): number {
  if (start >= viewStart && end <= viewEnd) return 0
  if (start < viewStart || end - start > viewEnd - viewStart) return start - viewStart
  return end - viewEnd
}

/** Page scroll that puts the spotlight in the band: untouched if inside, centred if not, top-aligned if taller. */
export function scrollDelta(spot: Rect, band: { top: number; bottom: number }): number {
  if (spot.bottom - spot.top >= band.bottom - band.top) return spot.top - band.top
  if (spot.top >= band.top && spot.bottom <= band.bottom) return 0
  return (spot.top + spot.bottom) / 2 - (band.top + band.bottom) / 2
}

/** How far a page scroll of `dy` would run past the end of the page (a short page on a phone, an anchor near its
 *  end): the room to add below it, so the anchor can still clear the docked bubble. */
export function missingRoom(dy: number, scrollY: number, maxScrollY: number): number {
  return Math.max(0, Math.ceil(scrollY + dy - maxScrollY))
}

/** Where a spotlight may sit: below the header, above the player bar (and above the bubble when it docks). */
export function freeBand(view: View, dock: boolean, bubbleHeight: number): { top: number; bottom: number } {
  const top = view.top + MARGIN
  const bottom = view.bottom - MARGIN - (dock ? bubbleHeight + MARGIN : 0)
  return { top, bottom: Math.max(top, bottom) }
}

export function placeBubble({
  spot,
  size,
  view,
  dock,
  avoid,
}: {
  spot: Rect | null
  size: Size
  view: View
  /** phones and short screens: always docked at the bottom, full width with gutters (at most DOCK_MAX_WIDTH) */
  dock: boolean
  avoid: readonly Rect[]
}): Placement {
  const floor = view.bottom - MARGIN
  const maxHeight = Math.max(0, floor - MARGIN)
  const height = Math.min(size.height, maxHeight)
  const dockTop = Math.max(MARGIN, floor - height)
  if (dock) {
    const width = Math.min(DOCK_MAX_WIDTH, Math.max(0, view.width - 2 * PHONE_GUTTER))
    return { left: (view.width - width) / 2, top: dockTop, width, maxHeight }
  }

  const width = Math.min(size.width, view.width - 2 * MARGIN)
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, view.width - width - MARGIN))
  const at = (left: number, top: number): Placement => ({ left, top, width, maxHeight })
  const box = (p: Placement): Rect => ({ left: p.left, top: p.top, right: p.left + width, bottom: p.top + height })

  const options: Placement[] = []
  if (!spot) {
    options.push(at(clampX((view.width - width) / 2), Math.max(MARGIN, Math.min((view.height - height) / 2, floor - height))))
  } else {
    const x = clampX((spot.left + spot.right) / 2 - width / 2)
    const below = spot.bottom + PAD + GAP
    const above = spot.top - PAD - GAP - height
    if (below + height <= floor) options.push(at(x, below))
    if (above >= MARGIN && above + height <= floor) options.push(at(x, above))
    options.push(at(x, dockTop))
  }
  const clear = options.find((p) => !avoid.some((a) => overlaps(box(p), a)))
  if (clear) return clear
  // every option covers the floating video: keep the first, moved to its left
  const first = options[0]
  const video = avoid.find((a) => overlaps(box(first), a))!
  return { ...first, left: Math.max(MARGIN, Math.min(first.left, video.left - MARGIN - width)) }
}
