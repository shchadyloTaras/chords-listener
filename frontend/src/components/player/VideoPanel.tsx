import clsx from 'clsx'
import { motion, useDragControls, useMotionValue } from 'framer-motion'
import { GripHorizontal, LoaderCircle, PanelRight, PictureInPicture2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t as translate, useT } from '../../i18n'
import { useApp } from '../../store'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { IconButton } from '../ui/IconButton'
import type { PlaybackEngine } from './engine'
import { usePlayerUi } from './playerUi'
import { isEmbedBlockedError, loadYouTubeApi, type YTPlayer } from './sources/youtubeApi'
import { YouTubeSource } from './sources/youtubeSource'

interface VideoPanelProps {
  engine: PlaybackEngine
  videoId: string
  trackId: string
}

/** Header height (h-14) + gap; the docked video sits right under the app header. */
const DOCK_TOP = 56 + 12

/**
 * YouTube player in a floating (draggable) mini window or docked:
 * a right-hand column on desktop, a strip under the header on phones.
 * The iframe never moves in the DOM, so switching modes does not reload it.
 */
export function VideoPanel({ engine, videoId, trackId }: VideoPanelProps) {
  const t = useT()
  const mode = usePlayerUi((s) => s.videoMode)
  const setMode = usePlayerUi((s) => s.setVideoMode)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const isWide = useMediaQuery('(min-width: 640px)')
  const docked = mode === 'dock'
  const mountRef = useRef<HTMLDivElement>(null)
  const constraintsRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const controls = useDragControls()
  const x = useMotionValue(0)
  const y = useMotionValue(0)

  // ---- create the YouTube player and hand playback over when ready
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    let cancelled = false
    let player: YTPlayer | null = null
    let source: YouTubeSource | null = null

    const fallback = (key: string) => {
      if (cancelled) return
      usePlayerUi.getState().markBlocked(trackId)
      useApp.getState().toast(translate(key), 'info')
    }

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return
        const el = document.createElement('div')
        host.appendChild(el)
        player = new YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            enablejsapi: 1,
            origin: window.location.origin,
            start: Math.floor(useApp.getState().currentTime),
          },
          events: {
            onReady: (e) => {
              if (cancelled) return
              source = engine.create((events) => new YouTubeSource(e.target, events))
              engine.attachOverlay(source)
              setReady(true)
            },
            onStateChange: (e) => source?.handleState(e.data),
            onError: (e) => fallback(isEmbedBlockedError(e.data) ? 'core.video.blocked' : 'core.video.failed'),
          },
        })
      })
      .catch(() => fallback('core.video.loadFailed'))

    return () => {
      cancelled = true
      if (source) engine.detachOverlay(source)
      try {
        player?.destroy()
      } catch {
        /* iframe already gone */
      }
      host.replaceChildren()
    }
  }, [engine, videoId, trackId])

  // ---- reserve layout space for the docked video (read by TrackPage via CSS vars)
  useEffect(() => {
    const root = document.documentElement.style
    if (docked) {
      root.setProperty('--video-dock-right', 'calc(min(36vw, 520px) + 24px)')
      // phones: 16:9 video + its 36px title bar + 1px border
      root.setProperty('--video-dock-top', 'calc(56.25vw + 37px)')
    }
    return () => {
      root.removeProperty('--video-dock-right')
      root.removeProperty('--video-dock-top')
    }
  }, [docked])

  useEffect(() => {
    if (docked) {
      x.set(0)
      y.set(0)
    }
  }, [docked, x, y])

  const floatWidth = isWide ? 360 : 'min(62vw, 260px)'
  const style = docked
    ? isDesktop
      ? { top: DOCK_TOP, right: 16, width: 'min(36vw, 520px)' }
      : { top: 56, left: 0, right: 0, width: '100%' }
    : { right: 16, bottom: 'calc(var(--player-h, 0px) + 16px)', width: floatWidth }

  return createPortal(
    <>
      <div
        ref={constraintsRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-2 top-16"
        style={{ bottom: 'calc(var(--player-h, 0px) + 8px)' }}
      />
      {/* the tour's bubble keeps clear of the floating video; the video docked under the header on phones adds to its top inset */}
      <motion.section
        aria-label={t('core.video.title')}
        data-tour-avoid={docked ? undefined : ''}
        data-tour-top={docked && !isDesktop ? '' : undefined}
        drag={!docked}
        dragControls={controls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0.04}
        dragConstraints={constraintsRef}
        style={{ ...style, x, y }}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.16 }}
        className={clsx(
          'fixed z-40 overflow-hidden border-border-strong bg-black shadow-2xl shadow-black/40',
          docked && !isDesktop ? 'border-b' : 'rounded-2xl border',
        )}
      >
        <div
          onPointerDown={(e) => !docked && controls.start(e)}
          className={clsx(
            'flex h-9 touch-none items-center gap-1 bg-surface-2 pr-1 pl-2.5 text-xs text-muted select-none',
            !docked && 'cursor-grab active:cursor-grabbing',
          )}
        >
          {!docked && <GripHorizontal className="size-4 text-faint" aria-hidden="true" />}
          <span className="flex-1 truncate">{t('core.video.title')}</span>
          <IconButton
            size="sm"
            label={docked ? t('core.video.float') : t('core.video.dock')}
            onClick={() => setMode(docked ? 'float' : 'dock')}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {docked ? <PictureInPicture2 className="size-4" /> : <PanelRight className="size-4" />}
          </IconButton>
          <IconButton
            size="sm"
            label={t('core.video.hide')}
            onClick={() => useApp.getState().setSetting('showVideo', false)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="relative aspect-video bg-black">
          <div ref={mountRef} className="absolute inset-0 [&_iframe]:size-full" />
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center text-white/60">
              <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
              <span className="sr-only">{t('core.loading')}</span>
            </div>
          )}
        </div>
      </motion.section>
    </>,
    document.body,
  )
}
