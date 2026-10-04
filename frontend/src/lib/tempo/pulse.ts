// Pulse grid: the beats to flash / click, each labelled with its position inside the bar shown
// in the chord sheet, so the beat indicator, the metronome accent and the sheet always agree.

import { barIndexAt } from '../music/bars'

export interface BarLike {
  start: number
  end: number
  /** [start, …inner beats…, end] */
  boundaries: number[]
  pickup?: boolean
}

export interface PulseGrid {
  /** beat onsets, ascending */
  times: number[]
  /** 0-based position of each beat inside its bar (0 = downbeat), already wrapped to 0..meter-1 */
  pos: number[]
  /** beats per bar shown by the indicator */
  meter: number
}

function nearestBoundary(boundaries: number[], t: number): number {
  let best = 0
  let bestD = Infinity
  for (let k = 0; k < boundaries.length; k++) {
    const d = Math.abs(boundaries[k] - t)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}

/** Position in a meter-long bar: a short pickup bar is right-aligned (its last beat is "4 of 4"). */
function wrapPos(k: number, bar: BarLike, meter: number): number {
  const n = bar.boundaries.length - 1
  const shift = bar.pickup && n < meter ? meter - n : 0
  return (k + shift) % meter
}

/**
 * Labels every beat with its position in the bar it falls into. Without usable beats the bars'
 * own beat boundaries become the pulse, so the indicator and the metronome still work.
 */
export function buildPulseGrid(beats: readonly number[], bars: BarLike[], meter: number): PulseGrid {
  const m = Math.min(12, Math.max(1, Math.round(meter) || 4))
  const times: number[] = []
  const pos: number[] = []
  if (!bars.length) return { times, pos, meter: m }

  if (beats.length >= 2) {
    for (const b of beats) {
      if (!Number.isFinite(b) || (times.length && b <= times[times.length - 1])) continue
      let i = barIndexAt(bars, b)
      if (i < 0) continue
      let k = nearestBoundary(bars[i].boundaries, b)
      if (k === bars[i].boundaries.length - 1) {
        // Closer to the next barline: it is that bar's downbeat.
        if (i + 1 >= bars.length) continue
        i += 1
        k = 0
      }
      times.push(b)
      pos.push(wrapPos(k, bars[i], m))
    }
    return { times, pos, meter: m }
  }

  for (const bar of bars) {
    for (let k = 0; k < bar.boundaries.length - 1; k++) {
      times.push(bar.boundaries[k])
      pos.push(wrapPos(k, bar, m))
    }
  }
  return { times, pos, meter: m }
}
