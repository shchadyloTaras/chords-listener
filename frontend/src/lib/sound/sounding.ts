// What the chord sound is playing right now, per chord diagram: the engine records every played
// note (the same timings it emits as live notes) and diagrams of that chord light the matching
// piano / harmonium keys / strings / handpan fields while each one sounds. Timer-driven only while something
// sounds; nothing runs when idle.

import { useEffect, useMemo, useState } from 'react'
import type { Instrument } from '../../store'
import type { LiveNote } from '../liveNotes'

export interface SoundingNote extends LiveNote {
  /** piano key index (0 = C4 of the diagram), harmonium key (0 = C3), guitar / ukulele string, handpan note index (0 = ding) */
  target: number
}

interface Entry {
  id: number
  instrument: Instrument
  /** chord label the notes were played for (diagrams match on it) */
  label: string
  notes: SoundingNote[]
}

let entries: Entry[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function prune(now: number): void {
  if (entries.some((e) => e.notes.every((n) => n.end <= now))) entries = entries.filter((e) => e.notes.some((n) => n.end > now))
}

export function addSounding(entry: Entry): void {
  prune(performance.now())
  entries.push(entry)
  notify()
}

/** Call after note ends were shortened in place (a newer chord cut them). */
export function touchSounding(): void {
  notify()
}

export function clearSounding(): void {
  if (!entries.length) return
  entries = []
  notify()
}

export function subscribeSounding(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Targets of `instrument` / `label` sounding at `now` (performance.now ms) and when that next changes. */
export function soundingAt(instrument: Instrument, label: string, now: number): { lit: number[]; next: number | null } {
  const lit = new Set<number>()
  let next: number | null = null
  const soon = (t: number) => {
    if (next == null || t < next) next = t
  }
  for (const e of entries) {
    if (e.instrument !== instrument || e.label !== label) continue
    for (const n of e.notes) {
      if (n.end <= n.start || n.end <= now) continue
      if (now >= n.start) {
        lit.add(n.target)
        soon(n.end)
      } else soon(n.start)
    }
  }
  return { lit: [...lit].sort((a, b) => a - b), next }
}

const EMPTY: ReadonlySet<number> = new Set()

/**
 * Diagram targets of this chord that are sounding right now. Re-renders only when the set
 * changes: a timer waits for the next note start / end while (and only while) notes are pending.
 */
export function useSoundingTargets(instrument: Instrument, label: string): ReadonlySet<number> {
  const [key, setKey] = useState('')
  useEffect(() => {
    let timer = 0
    const update = () => {
      window.clearTimeout(timer)
      const now = performance.now()
      const { lit, next } = soundingAt(instrument, label, now)
      setKey(lit.join(','))
      if (next != null) timer = window.setTimeout(update, Math.max(0, next - now) + 1)
    }
    update()
    const off = subscribeSounding(update)
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [instrument, label])
  return useMemo(() => (key ? new Set(key.split(',').map(Number)) : EMPTY), [key])
}
