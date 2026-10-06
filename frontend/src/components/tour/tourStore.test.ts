// @vitest-environment jsdom
// The running tour: one at a time, an empty tour never opens (and is not seen), pause + follow on song pages,
// close reasons and the seen flag, a vanished anchor, a route change, and «Інструкція» on each screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTourSeen } from '../../lib/tour/storage'
import { useApp, type PlayerController } from '../../store'
import { useChordUi } from '../chords/uiStore'
import { closeIfRouteChanged, closeTour, nextStep, prevStep, reportAnchorsGone, startCurrentTour, startTour, useTourStore } from './tourStore'

const made: HTMLElement[] = []
function anchor(id: string): HTMLElement {
  const el = document.createElement('div')
  el.dataset.tour = id
  el.getClientRects = () => [{}] as unknown as DOMRectList
  document.body.append(el)
  made.push(el)
  return el
}
const active = () => useTourStore.getState().active
const stepId = () => {
  const a = active()
  return a ? `${a.tourId}.${a.run.index}` : null
}

beforeEach(() => {
  localStorage.clear()
  window.location.hash = '#/'
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  useApp.setState({ isPlaying: false, controller: null, view: 'sheet' })
  useChordUi.setState({ followPaused: false })
})

afterEach(() => {
  made.splice(0).forEach((el) => el.remove())
  vi.useRealTimers()
})

describe('starting', () => {
  it('starts at the first available step; with none it does not open and is not marked seen', () => {
    expect(startTour('score')).toBe('empty')
    expect(active()).toBeNull()
    expect(isTourSeen('score')).toBe(false)
    expect(startTour('home')).toBe('started')
    expect(stepId()).toBe('home.0')
  })

  it('runs one tour at a time', () => {
    startTour('home')
    expect(startTour('listen')).toBe('busy')
    expect(active()?.tourId).toBe('home')
  })

  it('on a song page pauses the song and suspends following, restoring following on close', () => {
    window.location.hash = '#/demo'
    const pause = vi.fn()
    useApp.setState({ isPlaying: true, controller: { pause } as unknown as PlayerController })
    startTour('home')
    expect(pause).toHaveBeenCalledTimes(1)
    expect(useChordUi.getState().followPaused).toBe(true)
    closeTour('skip')
    expect(useChordUi.getState().followPaused).toBe(false)

    useChordUi.setState({ followPaused: true })
    startTour('home')
    closeTour('escape')
    expect(useChordUi.getState().followPaused).toBe(true)
  })

  it('leaves a recording alone on the listen page', () => {
    window.location.hash = '#/listen'
    const pause = vi.fn()
    useApp.setState({ isPlaying: true, controller: { pause } as unknown as PlayerController })
    startTour('listen')
    expect(pause).not.toHaveBeenCalled()
    expect(active()?.followPaused).toBeNull()
  })
})

describe('moving and closing', () => {
  it('next / back; a vanished anchor moves on; nothing left ends it as exhausted (seen)', () => {
    const input = anchor('home.input')
    const sources = anchor('home.sources')
    startTour('home')
    nextStep()
    expect(stepId()).toBe('home.1')
    prevStep()
    expect(stepId()).toBe('home.0')
    prevStep()
    expect(stepId()).toBe('home.0')
    nextStep()
    input.remove()
    reportAnchorsGone()
    expect(stepId()).toBe('home.2')
    sources.remove()
    reportAnchorsGone()
    expect(active()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it.each(['done', 'skip', 'escape', 'exhausted'] as const)('%s marks the tour seen', (reason) => {
    startTour('home')
    closeTour(reason)
    expect(active()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('«Далі» on the last step closes it as done', () => {
    startTour('home')
    nextStep()
    expect(active()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('a route change closes it at once, unseen, and drops the chained tour', () => {
    window.location.hash = '#/track/t1'
    useTourStore.setState({ flags: { keysPanel: true } })
    startCurrentTour()
    expect(useTourStore.getState().queue).toEqual(['keys'])
    closeIfRouteChanged('track:t1')
    expect(active()?.tourId).toBe('song')
    closeIfRouteChanged('home')
    expect(active()).toBeNull()
    expect(useTourStore.getState().queue).toEqual([])
    expect(isTourSeen('song')).toBe(false)
  })
})

describe('«Інструкція»', () => {
  it('on a song page runs Song (Score in «Ноти»), then Live keys after «Готово» only', () => {
    window.location.hash = '#/track/t1'
    useTourStore.setState({ flags: { keysPanel: true } })
    startCurrentTour()
    expect(active()?.tourId).toBe('song') // only the centred chord-marks step is available here
    nextStep()
    expect(active()?.tourId).toBe('keys')
    closeTour('skip')
    expect(active()).toBeNull()

    anchor('score.parts')
    useApp.setState({ view: 'score' })
    startCurrentTour()
    expect(active()?.tourId).toBe('score')
    closeTour('skip')
    expect(useTourStore.getState().queue).toEqual([])
    expect(active()).toBeNull()
  })

  it('does nothing on the processing and not-found pages', () => {
    window.location.hash = '#/job/j1'
    startCurrentTour()
    expect(active()).toBeNull()
    window.location.hash = '#/nope'
    startCurrentTour()
    expect(active()).toBeNull()
  })

  it('from the shortcuts dialog waits until the dialog has left the page', () => {
    vi.useFakeTimers()
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    startCurrentTour({ afterModal: true })
    vi.advanceTimersByTime(200)
    expect(active()).toBeNull()
    dialog.remove()
    vi.advanceTimersByTime(50)
    expect(active()?.tourId).toBe('home')
  })
})
