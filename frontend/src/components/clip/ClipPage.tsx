// The fragment picker (#/youtube/<videoId>[?t=<start>]): a signed-in user picks CLIP_SECONDS of a YouTube video and
// the cloud analyzes just that part (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md). Works by touch
// on a phone; the window's math is in clipWindow.ts. While the administrator has switched the cloud's YouTube download
// off (AC-27) there is nothing to pick: the video goes to the capture page instead.
import { ArrowDownToLine, ArrowLeft, LoaderCircle, Play, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { submitClip } from '../../hooks/useJobs'
import { currentPath, navigate, paths } from '../../hooks/useRoute'
import { toApiError } from '../../lib/api'
import { isAdminRefusal, useServiceStatus } from '../../lib/serviceStatus'
import { clipReady } from '../../lib/tour/trigger'
import { useApp } from '../../store'
import { errorText } from '../jobs/errorText'
import { isEmbedBlockedError, loadYouTubeApi, videoTitle, type YTPlayer } from '../player/sources/youtubeApi'
import { useTourTrigger } from '../tour/hooks'
import { Button } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { formatRange, formatTime } from '../ui/format'
import { ClipTimeline } from './ClipTimeline'
import { CLIP_SECONDS, clampStart, clipWindow, startAt } from './clipWindow'

type PlayerStatus = 'loading' | 'ready' | 'embed' | 'error'

/** The video's length once the player knows it: getDuration() is 0 until the metadata has loaded (on a phone often
 *  only after play starts), and a real 0 must never reach the window math. */
function playerLength(p: YTPlayer): number | null {
  try {
    const d = p.getDuration()
    return d > 0 && Number.isFinite(d) ? d : null
  } catch {
    return null
  }
}

export function ClipPage({ videoId, start: initialStart }: { videoId: string; start: number | null }) {
  const t = useT()
  const mountRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>('loading')
  const [title, setTitle] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [start, setStart] = useState(() => clampStart(initialStart ?? 0, null))
  const [busy, setBusy] = useState(false)
  /** «Прослухати»: the video pauses once it reaches this time */
  const previewEnd = useRef<number | null>(null)
  // the window stays inside the video once its length is known (a ?t= past the end moves back): `range` is
  // `start` clamped on every render, and the picker, the label and the job all read `range`, never `start`
  const range = clipWindow(start, duration)

  useDocumentTitle(title ? `${t('clip.title')} · ${title}` : t('clip.title'))

  // YouTube off in the cloud (the public status, read without waking the server): the fragment would only be refused,
  // so the video is listened to in the tab, from the start chosen so far (a bookmark, a retry, a switch learnt late)
  const youtubeOn = useServiceStatus((s) => s.status.switches.youtubeEnabled)
  useEffect(() => {
    if (!youtubeOn) navigate(paths.capture(videoId, { t: range.start }), { replace: true })
  }, [youtubeOn, videoId, range.start])

  // ---- the embedded player
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    let cancelled = false
    let player: YTPlayer | null = null
    const learnDuration = (p: YTPlayer) => {
      const d = playerLength(p)
      if (d) setDuration(d)
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
          playerVars: { playsinline: 1, rel: 0, iv_load_policy: 3, enablejsapi: 1, origin: window.location.origin },
          events: {
            onReady: (e) => {
              if (cancelled) return
              playerRef.current = e.target
              setPlayerStatus('ready')
              setTitle(videoTitle(e.target))
              learnDuration(e.target)
            },
            onStateChange: (e) => {
              // any state: the metadata can arrive with a buffering / cued / paused change as well as with play
              if (cancelled) return
              setTitle((prev) => prev ?? videoTitle(e.target))
              learnDuration(e.target)
            },
            onError: (e) => {
              if (!cancelled) setPlayerStatus(isEmbedBlockedError(e.data) ? 'embed' : 'error')
            },
          },
        })
      })
      .catch(() => {
        if (!cancelled) setPlayerStatus('error')
      })
    return () => {
      cancelled = true
      playerRef.current = null
      try {
        player?.destroy()
      } catch {
        /* iframe already gone */
      }
      host.replaceChildren()
    }
  }, [videoId])

  // ---- the playhead; «Прослухати» stops at the window's end; the video's length is picked up here too while it is
  // still unknown (the player gives it only once its metadata has loaded, and no event is guaranteed to say when)
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      try {
        const length = playerLength(p)
        if (length) setDuration((known) => known ?? length)
        const time = p.getCurrentTime() || 0
        setNow(time)
        if (previewEnd.current !== null && time >= previewEnd.current) {
          previewEnd.current = null
          p.pauseVideo()
        }
      } catch {
        /* not ready */
      }
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  const fromHere = () => setStart(startAt(now, duration))

  const preview = () => {
    const p = playerRef.current
    if (!p) return
    previewEnd.current = range.end
    p.seekTo(range.start, true)
    p.playVideo()
  }

  const analyze = async () => {
    if (busy) return
    setBusy(true)
    previewEnd.current = null
    try {
      playerRef.current?.pauseVideo()
    } catch {
      /* player gone */
    }
    const here = currentPath()
    try {
      await submitClip(videoId, range.start) // opens the job page
    } catch (e) {
      // the user left the picker while the request was pending: a redirect or a toast would pull them back
      if (currentPath() !== here) return
      const { code } = toApiError(e)
      // this cloud cannot download YouTube fragments: listen to the video in the tab, from the same place
      if (code === 'unavailable') navigate(paths.capture(videoId, { blocked: true, t: range.start }), { replace: true })
      // a guest (a bookmark, a shared link, after signing out): nothing was blocked, the capture page's own hint
      // offers the sign-in
      else if (code === 'server_required') navigate(paths.capture(videoId, { t: range.start }), { replace: true })
      // the administrator's refusal (YouTube off, a restricted account, paused analyses, AC-18/26/27): a retry would be
      // refused again, but the tab can still be listened to here; the reason (and the support address) is said once
      else if (isAdminRefusal(code)) {
        navigate(paths.capture(videoId, { t: range.start }), { replace: true })
        useApp.getState().toast(errorText(code), 'info')
      } else if (code !== 'aborted') useApp.getState().toast(errorText(code), 'error')
    } finally {
      setBusy(false)
    }
  }

  const ready = playerStatus === 'ready'
  const playerBroken = playerStatus === 'embed' || playerStatus === 'error'

  // the picker's tour: once the player has loaded (not while a fragment is being sent)
  useTourTrigger('clip', clipReady(playerStatus) && !busy)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">
      <Button variant="ghost" className="-ml-3" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(paths.home())}>
        {t('core.job.backHome')}
      </Button>

      <header className="mt-3">
        <p className="flex items-center gap-2 text-sm font-medium text-accent">
          <VideoSiteIcon className="size-4" />
          {t('clip.title')}
        </p>
        <h1 className="mt-1.5 font-display text-2xl leading-tight font-semibold tracking-tight break-words sm:text-3xl">
          {title ?? t('cloud.capture.untitled')}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{t('clip.intro', { seconds: CLIP_SECONDS })}</p>
      </header>

      <div className="relative mt-6 aspect-video overflow-hidden rounded-2xl border border-border-strong bg-black">
        <div ref={mountRef} className="absolute inset-0 [&_iframe]:size-full" />
        {playerStatus === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60" role="status">
            <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('core.loading')}</span>
          </div>
        )}
        {playerBroken && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/80">
            {t(playerStatus === 'embed' ? 'clip.embedBlocked' : 'clip.embedFailed', { time: formatTime(range.start) })}
          </div>
        )}
      </div>

      <section className="mt-5 rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm text-muted">{t('clip.window', { seconds: CLIP_SECONDS })}</p>
          <p className="font-display text-lg font-semibold tabular-nums" aria-live="polite">
            {formatRange(range.start, range.end, ' – ')}
          </p>
        </div>
        <ClipTimeline
          start={range.start}
          duration={duration}
          now={now}
          onChange={setStart}
          disabled={!duration}
          label={t('clip.windowLabel')}
        />
        {ready && !duration && <p className="mt-2 text-sm text-muted">{t('clip.needLength')}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<ArrowDownToLine className="size-4" />} onClick={fromHere} disabled={!ready} data-tour="clip.from">
            {t('clip.fromHere')}
          </Button>
          <Button icon={<Play className="size-4" />} onClick={preview} disabled={!ready} data-tour="clip.preview">
            {t('clip.preview')}
          </Button>
          <Button
            variant="primary"
            className="w-full sm:ml-auto sm:w-auto"
            icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            onClick={analyze}
            disabled={busy}
            data-tour="clip.analyze"
          >
            {t('clip.analyze')}
          </Button>
        </div>
      </section>
    </div>
  )
}
