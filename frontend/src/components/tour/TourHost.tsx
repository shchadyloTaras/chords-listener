// The guided tour on screen (docs/superpowers/specs/2026-10-06-onboarding-tour-design.md §2): one full-screen
// layer at z-[75] that dims the page around the step's anchors, swallows every press, and shows the bubble.
// It is role="dialog" + aria-modal, which mutes the app's hotkeys (their modalOpen() checks); its own keys run
// in a capture listener on window, ahead of Floating / Modal / Menu. Mounted once in App; renders nothing
// while no tour runs. Step logic: lib/tour; the running tour: tourStore.
import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCanListenInTab, useIsDesktopPointer, useMediaQuery } from '../../hooks/useMediaQuery'
import { useRoute } from '../../hooks/useRoute'
import { useT } from '../../i18n'
import { counter } from '../../lib/tour/machine'
import { PAD } from '../../lib/tour/placement'
import { textKey, titleKey, TOURS } from '../../lib/tour/tours'
import { tourRouteKey } from '../../lib/tour/trigger'
import { useCloudInvite } from '../account/cloudInvite'
import { Button } from '../ui/IconButton'
import { Kbd } from '../ui/Kbd'
import { ChordMarks } from './ChordMarks'
import { GONE_MS, measureStep, PHONE_QUERY, sameGeo, scrollToStep, stepElements, type Geo } from './geometry'
import { useTourFlags } from './hooks'
import { closeIfRouteChanged, closeTour, nextStep, prevStep, reportAnchorsGone, tourEnv, useTourStore, type ActiveTour } from './tourStore'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function TourHost() {
  const route = useRoute()
  const phone = useMediaQuery(PHONE_QUERY)
  const touch = !useIsDesktopPointer()
  const cloudInvite = useCloudInvite()
  const canListenInTab = useCanListenInTab()
  useTourFlags({ phone, touch, demo: route.name === 'demo', cloudInvite, canListenInTab })

  // leaving the screen (Back, a link, a pasted or dropped file that starts a song) ends the tour, unseen
  const routeKey = tourRouteKey(route)
  useEffect(() => {
    closeIfRouteChanged(routeKey)
  }, [routeKey])

  const active = useTourStore((s) => s.active)
  if (!active) return null
  return createPortal(<TourLayer key={active.tourId} active={active} phone={phone} />, document.body)
}

function TourLayer({ active, phone }: { active: ActiveTour; phone: boolean }) {
  const t = useT()
  const flags = useTourStore((s) => s.flags)
  const reduce = useMediaQuery(REDUCED_MOTION)
  const titleId = useId()
  const textId = useId()
  const bubble = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  // `moved` is false for the first geometry only: the bubble is parked off-screen until then, and a transition
  // class on it at that moment would slide it in from there
  const [geo, setGeo] = useState<{ geo: Geo; moved: boolean } | null>(null)

  const tour = TOURS[active.tourId]
  const step = tour.steps[active.run.index]
  const pos = counter(tour, active.run, tourEnv())
  const first = useRef(pos.first)
  useEffect(() => {
    first.current = pos.first
  })

  // focus goes back to where it was when the tour closes
  useLayoutEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      if (prev?.isConnected) prev.focus({ preventScroll: true })
    }
  }, [])

  // each step: its anchors into view, then focus on «Далі»
  useEffect(() => {
    scrollToStep(step, { phone, reduce, bubbleHeight: bubble.current?.offsetHeight ?? 0 })
    next.current?.focus({ preventScroll: true })
  }, [step, phone, reduce])

  // the spotlight follows scrolling (inner scrollers too), resizing and the anchors, at most once a frame;
  // a step's anchors count as gone only after GONE_MS
  useEffect(() => {
    let raf = 0
    let gone: number | undefined
    const anchored = step.anchors.length > 0 && !step.centre
    const update = () => {
      raf = 0
      const g = measureStep(step, bubble.current, phone)
      setGeo((prev) => (prev && sameGeo(prev.geo, g) ? prev : { geo: g, moved: prev !== null }))
      if (!anchored || g.present) {
        window.clearTimeout(gone)
        gone = undefined
      } else if (gone === undefined) {
        gone = window.setTimeout(() => {
          gone = undefined
          if (!measureStep(step, bubble.current, phone).present) reportAnchorsGone()
        }, GONE_MS)
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    ro?.observe(document.body)
    for (const el of stepElements(step)) ro?.observe(el)
    if (bubble.current) ro?.observe(bubble.current)
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(gone)
      ro?.disconnect()
      mo.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
    }
  }, [step, phone])

  // → next, ← back, Enter / Space press the focused button, Esc closes, Tab stays in the bubble; held keys
  // (auto-repeat) are swallowed so a long press cannot race through the tour; modified combos (Alt+← is the
  // browser's Back) are not the tour's, as in useHotkeys
  useEffect(() => {
    let spaceHeld = false
    const onKey = (e: KeyboardEvent) => {
      const box = bubble.current
      if (!box || !['Escape', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Tab'].includes(e.key)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === ' ') spaceHeld = true
      if (e.repeat && e.key !== 'Tab') return
      if (e.key === 'Escape') closeTour('escape')
      else if (e.key === 'ArrowRight') nextStep()
      else if (e.key === 'ArrowLeft') {
        if (!first.current) prevStep()
      } else if (e.key === 'Tab') {
        const items = [...box.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
        if (!items.length) return
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length].focus()
      } else {
        const el = document.activeElement
        if (el instanceof HTMLButtonElement && box.contains(el)) el.click()
      }
    }
    // Firefox clicks a focused button on the Space keyup even when the keydown was cancelled
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      spaceHeld = false
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      // the Space that pressed «Готово»: its keyup lands on the element focus went back to
      if (spaceHeld) {
        const swallow = (e: KeyboardEvent) => {
          if (e.key !== ' ') return
          e.preventDefault()
          window.removeEventListener('keyup', swallow, true)
        }
        window.addEventListener('keyup', swallow, true)
      }
    }
  }, [])

  const spot = geo?.geo.spot ?? null
  const place = geo?.geo.place
  const keys = !flags.touch && step.keys?.length ? step.keys : null
  const moving = !reduce && 'transition-[left,top,width,height] duration-200 ease-out'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={textId}
      data-tour-root=""
      className="fixed inset-0 z-[75]"
      onPointerDown={(e) => {
        // the page under the layer gets nothing, and focus stays in the bubble
        if (!bubble.current?.contains(e.target as Node)) e.preventDefault()
      }}
    >
      {spot ? (
        <div
          aria-hidden="true"
          className={clsx('pointer-events-none absolute rounded-xl shadow-[0_0_0_9999px_rgb(0_0_0/0.6)] ring-2 ring-accent', moving)}
          style={{ left: spot.left - PAD, top: spot.top - PAD, width: spot.right - spot.left + 2 * PAD, height: spot.bottom - spot.top + 2 * PAD }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-black/60" />
      )}
      <div
        ref={bubble}
        className={clsx(
          'absolute flex w-[22rem] max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded-2xl border border-border-strong bg-surface p-4 text-text shadow-2xl shadow-black/40',
          geo?.moved && moving,
        )}
        style={place ? { left: place.left, top: place.top, width: phone ? place.width : undefined, maxHeight: place.maxHeight } : { left: -9999, top: 0 }}
      >
        <div aria-live="polite">
          <h2 id={titleId} className="font-display text-[17px] leading-snug font-semibold tracking-tight">
            {t(titleKey(active.tourId, step))}
          </h2>
          <p id={textId} className="mt-1.5 text-sm leading-relaxed text-muted">
            {t(textKey(active.tourId, step, flags))}
          </p>
        </div>
        {step.body === 'chordMarks' && <ChordMarks className="mt-3" />}
        {keys && (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-auto font-mono text-xs text-faint tabular-nums">{t('tour.counter', { n: pos.ordinal, total: pos.total })}</span>
          <Button size="sm" variant="ghost" onClick={() => closeTour('skip')}>
            {t('tour.skip')}
          </Button>
          {!pos.first && (
            <Button size="sm" onClick={() => prevStep()}>
              {t('tour.back')}
            </Button>
          )}
          <Button ref={next} size="sm" variant="primary" onClick={() => nextStep()}>
            {t(pos.last ? 'tour.done' : 'tour.next')}
          </Button>
        </div>
      </div>
    </div>
  )
}
