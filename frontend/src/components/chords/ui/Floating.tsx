// Anchored floating panel rendered in a portal with fixed positioning (never clipped by
// scroll containers). Repositions on scroll/resize; closes on outside press / Escape.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top'

/** Space kept free at the bottom of the viewport for the sticky player bar. */
const BOTTOM_RESERVE = 88
const GAP = 8
const MARGIN = 8

interface FloatingProps {
  anchor: HTMLElement | null
  open: boolean
  onClose(): void
  placement?: Placement
  children: ReactNode
  className?: string
  /** close when the pointer is pressed outside both anchor and panel */
  dismissOnOutside?: boolean
  onPointerEnter?(): void
  onPointerLeave?(): void
  role?: string
  ariaLabel?: string
  id?: string
}

export function Floating({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  children,
  className,
  dismissOnOutside = true,
  onPointerEnter,
  onPointerLeave,
  role = 'dialog',
  ariaLabel,
  id,
}: FloatingProps) {
  const panel = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: -9999, top: -9999, opacity: 0 })
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  const place = useCallback(() => {
    const el = panel.current
    if (!anchor || !el) return
    if (!anchor.isConnected) {
      closeRef.current()
      return
    }
    const a = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left =
      placement === 'bottom-end' ? a.right - w : placement === 'bottom' || placement === 'top' ? a.left + a.width / 2 - w / 2 : a.left
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN))
    const below = a.bottom + GAP
    const above = a.top - GAP - h
    const fitsBelow = below + h <= vh - BOTTOM_RESERVE
    const fitsAbove = above >= MARGIN
    let top = placement === 'top' ? (fitsAbove ? above : below) : fitsBelow || !fitsAbove ? below : above
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN))
    setStyle({ position: 'fixed', left, top, opacity: 1 })
  }, [anchor, placement])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place, children])

  useEffect(() => {
    if (!open) return
    let raf = 0
    const onMove = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(place)
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMove) : null
    if (panel.current) ro?.observe(panel.current)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        anchor?.focus?.({ preventScroll: true })
      }
    }
    const onDown = (e: PointerEvent) => {
      if (!dismissOnOutside) return
      const target = e.target as Node
      if (panel.current?.contains(target) || anchor?.contains(target)) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, place, anchor, dismissOnOutside])

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={panel}
      id={id}
      role={role}
      aria-label={ariaLabel}
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={clsx(
        'z-[60] rounded-xl border border-border-strong bg-surface-2 text-text shadow-[0_12px_40px_-12px_rgb(0_0_0/0.55)] transition-opacity duration-100',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  )
}
