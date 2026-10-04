// Playhead clock: a per-frame time source for the chord UI.
// While playing it reads the player controller directly on rAF (so progress fills stay smooth
// whatever rate the player pushes `currentTime` at); while paused it mirrors store.currentTime.
// Components subscribe narrowly: either a derived primitive (useClockValue → re-render only when
// it changes) or a raw callback (useClockEffect → mutate DOM refs, no re-render).

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useApp } from '../../store'

type Listener = (t: number) => void

const listeners = new Set<Listener>()
let time = 0
let raf = 0
let unsubscribeStore: (() => void) | null = null

function read(): number {
  const s = useApp.getState()
  if (s.isPlaying && s.controller) {
    try {
      const t = s.controller.getTime()
      if (Number.isFinite(t)) return t
    } catch {
      // controller not ready yet
    }
  }
  return s.currentTime
}

function update(): void {
  const t = read()
  if (t === time) return
  time = t
  for (const l of listeners) l(t)
}

function tick(): void {
  raf = 0
  update()
  schedule()
}

function schedule(): void {
  if (!raf && listeners.size && useApp.getState().isPlaying && typeof requestAnimationFrame !== 'undefined') {
    raf = requestAnimationFrame(tick)
  }
}

function ensureStarted(): void {
  if (unsubscribeStore) return
  time = read()
  unsubscribeStore = useApp.subscribe((s, p) => {
    if (s.currentTime !== p.currentTime || s.isPlaying !== p.isPlaying || s.controller !== p.controller) {
      update()
      schedule()
    }
  })
}

export function subscribeClock(l: Listener): () => void {
  ensureStarted()
  listeners.add(l)
  schedule()
  return () => {
    listeners.delete(l)
    if (!listeners.size && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

export function getClockTime(): number {
  ensureStarted()
  return time
}

/**
 * Derived value from the playhead time; the component re-renders only when the derived
 * value changes (must return a primitive or a stable reference).
 */
export function useClockValue<T>(derive: (t: number) => T): T {
  const subscribe = useCallback((cb: () => void) => subscribeClock(cb), [])
  // Recompute when `derive` identity changes (e.g. new chord list) as well as on time ticks.
  const getSnapshot = useCallback(() => derive(getClockTime()), [derive])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Runs `effect(t)` on every clock tick (and once immediately) without re-rendering. */
export function useClockEffect(effect: (t: number) => void, deps: unknown[]): void {
  const ref = useRef(effect)
  useLayoutEffect(() => {
    ref.current = effect
  })
  useEffect(() => {
    ref.current(getClockTime())
    return subscribeClock((t) => ref.current(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-provided deps (custom effect hook)
  }, deps)
}
