// The step machine: which steps are included (conditions + anchors on screen, re-evaluated at every step
// change), the counter and «Готово», back / next at the ends, a vanished anchor vs a centre card, close
// reasons, and the chain of a re-opened tour (Song → Live keys only after «Готово»).
import { describe, expect, it } from 'vitest'
import { advance, afterClose, anchorsGone, counter, goBack, marksSeen, startRun, stepIncluded, type StepEnv, type TourRun } from './machine'
import type { Tour, TourFlags } from './tours'

const TOUR: Tour = {
  id: 'home',
  steps: [
    { id: 'a', anchors: [] }, // 0: no anchor → always (a centred card)
    { id: 'b', anchors: ['x'] }, // 1: needs x
    { id: 'c', anchors: ['y'], when: ['libraryEmpty'] }, // 2: needs y and a flag
    { id: 'd', anchors: ['z'], centre: true }, // 3: centre → kept without z
    { id: 'e', anchors: ['x', 'y'] }, // 4: either anchor
  ],
}

const env = (present: string[], flags: TourFlags = {}): StepEnv => ({ flags, present: (a) => present.includes(a) })
const run = (index: number, history: number[] = []): TourRun => ({ index, history })

describe('which steps are included', () => {
  it('needs every condition and, unless centre or anchorless, one anchor on screen', () => {
    const included = (e: StepEnv) => TOUR.steps.map((s, i) => (stepIncluded(s, e) ? i : -1)).filter((i) => i >= 0)
    expect(included(env([]))).toEqual([0, 3])
    expect(included(env(['x']))).toEqual([0, 1, 3, 4])
    expect(included(env(['y']))).toEqual([0, 3, 4])
    expect(included(env(['y'], { libraryEmpty: true }))).toEqual([0, 2, 3, 4])
  })

  it('starts at the first included step; with none it does not start', () => {
    expect(startRun(TOUR, env([]))).toEqual(run(0))
    const anchoredOnly: Tour = { id: 'score', steps: [{ id: 'p', anchors: ['p'] }, { id: 'q', anchors: ['q'] }] }
    expect(startRun(anchoredOnly, env([]))).toBeNull()
    expect(startRun(anchoredOnly, env(['q']))).toEqual(run(1))
  })
})

describe('next, back and the counter', () => {
  it('counts among the steps included now («2 / 4» when one was left out)', () => {
    const e = env(['x'])
    expect(counter(TOUR, run(0), e)).toEqual({ ordinal: 1, total: 4, first: true, last: false })
    const r1 = advance(TOUR, run(0), e)
    expect(r1).toEqual({ run: run(1, [0]) })
    expect(counter(TOUR, run(1, [0]), e)).toEqual({ ordinal: 2, total: 4, first: false, last: false })
    expect(counter(TOUR, run(4, [0, 1, 3]), e)).toEqual({ ordinal: 4, total: 4, first: false, last: true })
  })

  it('re-evaluates at each step change: a step that became available is shown', () => {
    expect(advance(TOUR, run(1, [0]), env(['x', 'y'], { libraryEmpty: true }))).toEqual({ run: run(2, [0, 1]) })
  })

  it('«Далі» on the last included step ends the tour as done', () => {
    expect(advance(TOUR, run(4, [0, 1, 3]), env(['x']))).toEqual({ end: 'done' })
    expect(advance(TOUR, run(3, [0]), env([]))).toEqual({ end: 'done' })
  })

  it('«Назад» goes to the previous shown step, skipping one that is gone, and not before the first', () => {
    expect(goBack(TOUR, run(0), env(['x']))).toBeNull()
    expect(goBack(TOUR, run(3, [0, 1]), env(['x']))).toEqual(run(1, [0]))
    expect(goBack(TOUR, run(3, [0, 1]), env([]))).toEqual(run(0, []))
  })

  it('the counter does not count a shown step whose anchor has gone since', () => {
    expect(counter(TOUR, run(3, [0, 1]), env([]))).toEqual({ ordinal: 2, total: 2, first: false, last: true })
  })
})

describe('a vanished anchor', () => {
  it('keeps a centre step open as a centred card', () => {
    expect(anchorsGone(TOUR, run(3, [0]), env([]))).toEqual({ run: run(3, [0]) })
  })

  it('moves any other step on to the next available one', () => {
    expect(anchorsGone(TOUR, run(1, [0]), env([]))).toEqual({ run: run(3, [0, 1]) })
  })

  it('ends the tour as exhausted when nothing is left', () => {
    expect(anchorsGone(TOUR, run(4, [0, 1, 3]), env([]))).toEqual({ end: 'exhausted' })
  })
})

describe('closing', () => {
  it('«Готово», «Пропустити», Esc and running out mark the tour seen; leaving the screen does not', () => {
    expect(marksSeen('done')).toBe(true)
    expect(marksSeen('skip')).toBe(true)
    expect(marksSeen('escape')).toBe(true)
    expect(marksSeen('exhausted')).toBe(true)
    expect(marksSeen('route')).toBe(false)
  })

  it('a chained tour follows only «Готово»; anything else drops the queue', () => {
    expect(afterClose(['keys'], 'done')).toEqual({ next: 'keys', queue: [] })
    expect(afterClose(['score', 'keys'], 'done')).toEqual({ next: 'score', queue: ['keys'] })
    for (const reason of ['skip', 'escape', 'exhausted', 'route'] as const) expect(afterClose(['keys'], reason)).toEqual({ next: null, queue: [] })
    expect(afterClose([], 'done')).toEqual({ next: null, queue: [] })
  })
})
