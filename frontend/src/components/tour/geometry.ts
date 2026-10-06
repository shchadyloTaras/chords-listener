// Where the tour's spotlight and bubble go on the real page: anchor boxes clipped to their scroller, the
// viewport and the header / player bar, and scrolling a step's anchors into view on both axes. The arithmetic
// is in lib/tour/placement.ts.
import { freeBand, intersectRect, missingRoom, nearestDelta, placeBubble, scrollDelta, unionRect, type Placement, type Rect, type View } from '../../lib/tour/placement'
import type { TourStep } from '../../lib/tour/tours'
import { anchorElement } from './dom'

/** below Tailwind's `sm`: phone content (the ⋯ step, Song step 4 split) and a docked bubble */
export const PHONE_QUERY = '(max-width: 639px)'
/** a short screen wider than a phone (a phone in landscape): the bubble docks as on phones, so the spotlight is
 *  scrolled above it instead of being centred where neither side has room; the content stays the desktop one */
export const SHORT_QUERY = '(max-height: 499px)'
/** an anchor counts as gone only if it is still missing this long after it vanished */
export const GONE_MS = 300
/** the bubble's size before it has been measured */
const FALLBACK = { width: 352, height: 180 }

export interface Geo {
  /** at least one of the step's anchors is rendered */
  present: boolean
  /** the visible union of the anchors (null: a centred card) */
  spot: Rect | null
  place: Placement
}

const box = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

export function stepElements(step: TourStep): HTMLElement[] {
  return step.anchors.map(anchorElement).filter((el): el is HTMLElement => el !== null)
}

/** The anchor's box; `data-tour-until="<selector>"` ends it at its first match (a heading with its first row). */
function anchorRect(el: HTMLElement): Rect {
  const r = box(el.getBoundingClientRect())
  const until = el.dataset.tourUntil
  const stop = until ? el.querySelector(until) : null
  if (stop && stop.getClientRects().length) r.bottom = Math.min(r.bottom, stop.getBoundingClientRect().bottom)
  return r
}

/** Inside the fixed player bar, or a sticky bar that is stuck right now (the header, the toolbar). */
function inStickyOrFixed(el: HTMLElement): boolean {
  for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.position === 'fixed') return true
    if (cs.position === 'sticky') {
      const top = parseFloat(cs.top)
      if (Number.isFinite(top) && p.getBoundingClientRect().top <= top + 1) return true
    }
  }
  return false
}

function scrollingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return p
  }
  return null
}

function horizontalScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX
    if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return p
  }
  return null
}

function playerHeight(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--player-h'))
  return Number.isFinite(v) ? v : 0
}

/** The bottom of the sticky app header, a video docked under it, or the toolbar while it is stuck. */
function topInset(): number {
  let inset = document.querySelector('header.sticky')?.getBoundingClientRect().bottom ?? 0
  for (const el of document.querySelectorAll('[data-tour-top]')) inset = Math.max(inset, el.getBoundingClientRect().bottom)
  const bar = document.querySelector('[data-cw-toolbar]')?.getBoundingClientRect()
  if (bar && bar.top <= inset + 1 && bar.bottom > inset) inset = bar.bottom
  return Math.max(0, inset)
}

function currentView(): View {
  const height = window.innerHeight
  return { width: document.documentElement.clientWidth || window.innerWidth, height, top: topInset(), bottom: height - playerHeight() }
}

function visibleRect(el: HTMLElement, view: View): Rect | null {
  let r: Rect | null = anchorRect(el)
  const sc = scrollingAncestor(el)
  if (sc) r = intersectRect(r, box(sc.getBoundingClientRect()))
  // in-flow anchors are clipped to the free area; pinned ones (header, player bar) only to the viewport
  const clip: Rect = inStickyOrFixed(el)
    ? { left: 0, top: 0, right: view.width, bottom: view.height }
    : { left: 0, top: view.top, right: view.width, bottom: view.bottom }
  return r && intersectRect(r, clip)
}

function avoidRects(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>('[data-tour-avoid]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => box(el.getBoundingClientRect()))
}

export function measureStep(step: TourStep, bubble: HTMLElement | null, dock: boolean): Geo {
  const view = currentView()
  const els = stepElements(step)
  const spot = unionRect(els.map((el) => visibleRect(el, view)).filter((r): r is Rect => r !== null))
  const size = bubble && bubble.offsetWidth ? { width: bubble.offsetWidth, height: bubble.offsetHeight } : FALLBACK
  return { present: els.length > 0, spot, place: placeBubble({ spot, size, view, dock, avoid: avoidRects() }) }
}

export function sameGeo(a: Geo, b: Geo): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A docked bubble (phones, short screens): an empty block past the end of the page while a tour runs, so an
 *  anchor near the end of a short page can still scroll above it. Placed on the initial containing block, it
 *  lengthens the page whatever the app's own layout; it only grows, and goes when the tour closes
 *  (removeScrollRoom). */
let room: HTMLDivElement | null = null

function addScrollRoom(px: number): void {
  if (px <= 0) return
  if (!room) {
    room = document.createElement('div')
    room.setAttribute('aria-hidden', 'true')
    room.dataset.tourRoom = ''
  }
  room.style.cssText = `position:absolute;left:0;width:1px;pointer-events:none;top:${document.documentElement.scrollHeight}px;height:${px}px`
  document.body.append(room)
}

export function removeScrollRoom(): void {
  room?.remove()
  room = null
}

/** Before a step: its anchors into view — sideways inside their own scrollers, then the page (if not pinned):
 *  centred in the free band, except `scrollTop` steps, which move only as far as needed. */
export function scrollToStep(step: TourStep, opts: { dock: boolean; reduce: boolean; bubbleHeight: number }): void {
  const behavior: ScrollBehavior = opts.reduce ? 'auto' : 'smooth'
  // the hero's key and BPM badges exist only while the hero is on screen
  if (step.scrollTop && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'auto' })
  const els = stepElements(step)
  const groups = new Map<HTMLElement, Rect[]>()
  for (const el of els) {
    const sc = horizontalScroller(el)
    if (sc) groups.set(sc, [...(groups.get(sc) ?? []), anchorRect(el)])
  }
  for (const [sc, rects] of groups) {
    const u = unionRect(rects)!
    const c = sc.getBoundingClientRect()
    const dx = nearestDelta(u.left, u.right, c.left, c.right)
    if (dx) sc.scrollBy({ left: dx, behavior })
  }
  const target = unionRect(els.filter((el) => !inStickyOrFixed(el)).map(anchorRect))
  if (!target) return
  const band = freeBand(currentView(), opts.dock, opts.bubbleHeight)
  // Song steps 1–4 scroll as little as possible: centring the toolbar under the live-piano panel would scroll
  // the hero away, and the toolbar then swaps the key badge (song.key) for the mini "now → next"
  const dy = step.scrollTop ? nearestDelta(target.top, target.bottom, band.top, band.bottom) : scrollDelta(target, band)
  if (opts.dock) addScrollRoom(missingRoom(dy, window.scrollY, document.documentElement.scrollHeight - window.innerHeight))
  if (Math.abs(dy) > 1) window.scrollBy({ top: dy, behavior })
}
