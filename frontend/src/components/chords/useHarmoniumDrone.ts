// The harmonium's drone, mounted with the chord workspace: holds the song's tonic while the
// harmonium is chosen, the drone is on (./HarmoniumDrone) and the song plays.

import { useEffect } from 'react'
import { droneMidi, soundEngine } from '../../lib/sound'
import { useApp } from '../../store'
import type { KeyInfo } from '../../types'

/** Holds the drone while the harmonium is chosen, the drone is on and the song plays. */
export function useHarmoniumDrone(key: KeyInfo | null | undefined, transpose: number): void {
  const enabled = useApp((s) => s.instrument === 'harmonium' && s.harmoniumDrone)
  const playing = useApp((s) => s.isPlaying)
  const midi = droneMidi(key, transpose)
  const want = enabled && playing && midi != null

  useEffect(() => {
    void soundEngine.setDrone(want ? midi : null)
  }, [want, midi])
  useEffect(() => () => void soundEngine.setDrone(null), [])

  // Audio may only start inside a user gesture: while the drone is on, every click / key press wakes
  // the audio up, so it already runs when that press starts the song.
  useEffect(() => {
    if (!enabled || midi == null) return
    const wake = () => void soundEngine.unlock()
    window.addEventListener('click', wake, { capture: true })
    window.addEventListener('keydown', wake, { capture: true })
    return () => {
      window.removeEventListener('click', wake, { capture: true })
      window.removeEventListener('keydown', wake, { capture: true })
    }
  }, [enabled, midi])
}
