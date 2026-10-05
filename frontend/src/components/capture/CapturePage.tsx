import clsx from 'clsx'
import {
  ArrowLeft,
  CircleAlert,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Mic,
  MonitorSmartphone,
  Pause,
  Play,
  RotateCcw,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { t as tNow, useT } from '../../i18n'
import { openAuthDialog, useAuth } from '../../lib/auth'
import { useConnection } from '../../lib/serverMode'
import { useApp } from '../../store'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useJobs } from '../../hooks/useJobs'
import { useCanListenInTab } from '../../hooks/useMediaQuery'
import { navigate, paths } from '../../hooks/useRoute'
import { toApiError } from '../../lib/api'
import { errorText } from '../jobs/errorText'
import { startFiles } from '../input/startFiles'
import { FILE_ACCEPT } from '../input/url'
import { isEmbedBlockedError, loadYouTubeApi, YT_STATE, type YTPlayer } from '../player/sources/youtubeApi'
import { Button } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { formatTime } from '../ui/format'
import { LiveChordsView } from '../live'
import { chooseStartOffset, isCapturing, playerEvent, type CaptureFailure } from './machine'
import { recordingFilename, saveRecording } from './saveRecording'
import { ShareTabIllustration } from './ShareTabIllustration'
import { useCapture } from './useCapture'

type PlayerStatus = 'loading' | 'ready' | 'embed' | 'error'

/** The IFrame API also reports the loaded video's title (not in the typed surface). */
type YTPlayerWithData = YTPlayer & { getVideoData?(): { title?: string; author?: string } }

function videoTitle(player: YTPlayer | null): string | null {
  try {
    const title = (player as YTPlayerWithData | null)?.getVideoData?.()?.title?.trim()
    return title || null
  } catch {
    return null
  }
}

function failureText(error: CaptureFailure | null, reason: string): string {
  switch (error) {
    case null:
      return ''
    case 'too-short':
      return tNow('cloud.capture.tooShort')
    case 'save':
      return tNow('cloud.capture.saveFailed', { reason })
    case 'embed':
      return tNow('cloud.capture.error.embed')
    case 'player':
      return tNow('cloud.capture.error.player')
    default:
      return tNow(`cloud.capture.error.${error}`)
  }
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('rounded-3xl border border-border bg-surface p-5 sm:p-6', className)}>{children}</div>
}

/** Upload progress of the recording (cloud): the newest upload entry. */
function SavingCard() {
  const t = useT()
  const upload = useJobs((s) => s.uploads[s.uploads.length - 1])
  const pct = upload ? Math.round(upload.progress * 100) : null
  return (
    <Card className="mt-4" >
      <div className="flex items-center gap-3" role="status">
        <LoaderCircle className="size-5 shrink-0 animate-spin text-accent" aria-hidden="true" />
        <p className="flex-1 text-sm text-text">{pct === null ? t('cloud.capture.preparing') : t('cloud.capture.saving')}</p>
        {pct !== null && <span className="font-mono text-sm text-text tabular-nums">{pct}%</span>}
      </div>
      {pct !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
        </div>
      )}
    </Card>
  )
}

/** Phones / browsers without tab audio: the microphone (song playing nearby) or a file. */
function NoTabCapture({ url }: { url: string }) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <MonitorSmartphone className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">{t('cloud.capture.phone.title')}</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-muted">{t('cloud.capture.phone.text')}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button variant="primary" icon={<Mic className="size-4" aria-hidden="true" />} onClick={() => navigate(paths.listen('mic'))}>
          {t('cloud.capture.phone.mic')}
        </Button>
        <Button icon={<FolderOpen className="size-4" aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
          {t('cloud.capture.phone.file')}
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-muted hover:bg-surface-3 hover:text-text"
        >
          <ExternalLink className="size-4" aria-hidden="true" />
          {t('cloud.capture.openYoutube')}
        </a>
        <input
          ref={fileRef}
          type="file"
          accept={FILE_ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files?.length) startFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
    </Card>
  )
}

/**
 * "Слухати у вкладці" (#/listen/youtube/<videoId>): the video plays embedded here while the site captures
 * this tab's audio, shows live chords, pauses / resumes the recording with the video, and at the end saves
 * the recording as a track linked to the video (the cloud for signed-in users, this browser otherwise).
 * Where the browser cannot listen to a tab (phones, Safari, Firefox) the microphone and files are offered.
 */
export function CapturePage({ videoId, blocked }: { videoId: string; blocked: boolean }) {
  const t = useT()
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const signedIn = useAuth((s) => !!s.user)
  const cloud = useConnection((s) => s.backend === 'cloud')
  const tabCapture = useCanListenInTab()

  const mountRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>('loading')
  const [title, setTitle] = useState<string | null>(null)
  const [position, setPosition] = useState(0)
  /** video time where the recording began (set when the video starts playing) */
  const startOffsetRef = useRef<number | null>(null)
  const titleRef = useRef<string | null>(null)
  useEffect(() => {
    titleRef.current = title
  }, [title])

  const save = useCallback(
    (rec: { audio: Blob; mime: string }) =>
      saveRecording(rec.audio, rec.mime, {
        title: titleRef.current ?? tNow('cloud.capture.untitled'),
        video: { videoId, url, startOffset: startOffsetRef.current ?? 0 },
      }),
    [videoId, url],
  )
  const capture = useCapture({
    save,
    onAutoStop: (reason) => {
      try {
        playerRef.current?.pauseVideo()
      } catch {
        /* player gone */
      }
      useApp.getState().toast(tNow(reason === 'limit' ? 'cloud.capture.limit' : 'cloud.capture.ended'), 'info')
    },
  })
  const { state, dispatch, current } = capture

  useDocumentTitle(title ? `${t('cloud.capture.title')} · ${title}` : t('cloud.capture.title'))

  // ---- the embedded player (created once per video)
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    let cancelled = false
    let player: YTPlayer | null = null
    setPlayerStatus('loading')
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
            },
            onStateChange: (e) => {
              if (cancelled) return
              const phase = current().phase
              if (e.data === YT_STATE.PLAYING) {
                setTitle((prev) => prev ?? videoTitle(e.target))
                if (phase === 'starting' && startOffsetRef.current === null) {
                  // the recording begins here: its time 0 is this point of the video
                  let at = 0
                  try {
                    at = e.target.getCurrentTime() || 0
                  } catch {
                    /* keep 0 */
                  }
                  startOffsetRef.current = at < 0.25 ? 0 : Math.round(at * 1000) / 1000
                }
              }
              const event = playerEvent(e.data)
              if (event && isCapturing(phase)) dispatch(event)
            },
            onError: (e) => {
              if (cancelled) return
              setPlayerStatus(isEmbedBlockedError(e.data) ? 'embed' : 'error')
              if (isCapturing(current().phase)) dispatch({ type: 'stop' })
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
  }, [videoId, dispatch, current])

  // ---- before starting: where the video is (to offer "start at 1:23")
  useEffect(() => {
    if (state.phase !== 'idle' && state.phase !== 'error') return
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      try {
        setPosition(chooseStartOffset(p.getCurrentTime(), p.getDuration()))
      } catch {
        /* not ready */
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [state.phase])

  // ---- while recording: the video must not jump (that would tear the recording from the video)
  useEffect(() => {
    if (state.phase !== 'live') return
    let last: { time: number; at: number } | null = null
    let warnedAt = 0
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      let now: number
      try {
        now = p.getCurrentTime()
      } catch {
        return
      }
      const at = performance.now()
      if (last) {
        const expected = last.time + (at - last.at) / 1000
        if (now > expected + 1.5 || now < last.time - 1) {
          p.seekTo(expected, true)
          if (at - warnedAt > 4000) {
            warnedAt = at
            useApp.getState().toast(tNow('cloud.capture.noSeek', { time: formatTime(expected) }), 'info')
          }
          last = { time: expected, at }
          return
        }
      }
      last = { time: now, at }
    }, 500)
    return () => window.clearInterval(id)
  }, [state.phase])

  const begin = async (fromPosition: boolean) => {
    const p = playerRef.current
    if (!p) return
    const offset = fromPosition ? position : 0
    try {
      p.pauseVideo()
    } catch {
      /* not started yet */
    }
    startOffsetRef.current = null
    // the capture prompt must come straight from the click
    const ok = await capture.start('tab', { waitForMedia: true })
    if (!ok || !playerRef.current) return
    try {
      p.unMute()
      p.setVolume(100)
      p.setPlaybackRate(1)
      p.seekTo(offset, true)
      p.playVideo()
    } catch {
      dispatch({ type: 'failed', error: 'player' })
    }
  }

  const togglePause = () => {
    const p = playerRef.current
    if (!p) return
    if (state.phase === 'live') p.pauseVideo()
    else if (state.phase === 'paused') p.playVideo()
  }

  const stop = () => {
    try {
      playerRef.current?.pauseVideo()
    } catch {
      /* player gone */
    }
    dispatch({ type: 'stop' })
  }

  const cancel = () => {
    try {
      playerRef.current?.pauseVideo()
    } catch {
      /* player gone */
    }
    capture.cancel()
    useApp.getState().toast(tNow('cloud.capture.cancelled'), 'info')
  }

  const downloadRecording = () => {
    const rec = capture.recording
    if (!rec) return
    const href = URL.createObjectURL(rec.audio)
    const a = document.createElement('a')
    a.href = href
    a.download = recordingFilename(title ?? tNow('cloud.capture.untitled'), rec.mime)
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
  }

  const phase = state.phase
  const capturing = isCapturing(phase)
  const showLive = capturing || phase === 'stopping' || phase === 'saving' || phase === 'done'
  const playerBroken = playerStatus === 'embed' || playerStatus === 'error'
  const errorMessage = state.error ? failureText(state.error, errorText(toApiError(capture.saveError).code)) : ''

  const statusText =
    phase === 'requesting'
      ? t('cloud.capture.requesting')
      : phase === 'starting'
        ? t('cloud.capture.waiting')
        : phase === 'live'
          ? t('cloud.capture.listening')
          : phase === 'paused'
            ? t('cloud.capture.paused')
            : null

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">
      <Button variant="ghost" className="-ml-3" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(paths.home())}>
        {t('core.job.backHome')}
      </Button>

      <header className="mt-3 max-w-3xl">
        <p className="flex items-center gap-2 text-sm font-medium text-accent">
          <VideoSiteIcon className="size-4" />
          {t('cloud.capture.title')}
        </p>
        <h1 className="mt-1.5 font-display text-2xl leading-tight font-semibold tracking-tight break-words sm:text-3xl">
          {title ?? t('cloud.capture.untitled')}
        </h1>
        {/* "the video plays here and the site hears this tab": not where the tab cannot be heard */}
        {(blocked || tabCapture) && (
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{blocked ? t('cloud.capture.blocked') : t('cloud.capture.intro')}</p>
        )}
        {!signedIn && (
          <p className="mt-1.5 text-sm text-muted">
            {t('cloud.capture.guest')}{' '}
            <button type="button" onClick={() => openAuthDialog('signIn')} className="font-medium text-accent hover:underline">
              {t('cloud.capture.signInHint')}
            </button>
          </p>
        )}
      </header>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
        {/* ---- video */}
        <div>
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-border-strong bg-black">
            <div ref={mountRef} className="absolute inset-0 [&_iframe]:size-full" />
            {playerStatus === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center text-white/60" role="status">
                <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('core.loading')}</span>
              </div>
            )}
            {playerBroken && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-2 p-6 text-center">
                <CircleAlert className="size-6 text-danger" aria-hidden="true" />
                <p className="max-w-md text-sm text-text">
                  {t(playerStatus === 'embed' ? 'cloud.capture.error.embed' : 'cloud.capture.error.player')}
                </p>
                <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
                  <ExternalLink className="size-4" aria-hidden="true" />
                  {t('cloud.capture.openYoutube')}
                </a>
              </div>
            )}
            {(phase === 'live' || phase === 'paused') && (
              // recording: clicks pause / resume instead of reaching the video's own controls (no seeking)
              <button
                type="button"
                aria-label={phase === 'live' ? t('cloud.capture.pause') : t('cloud.capture.resume')}
                title={t('cloud.capture.overlay')}
                onClick={togglePause}
                className="group absolute inset-0 flex items-center justify-center bg-transparent"
              >
                <span
                  className={clsx(
                    'flex size-16 items-center justify-center rounded-full bg-black/55 text-white transition-opacity duration-150',
                    phase === 'paused' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                  )}
                >
                  {phase === 'live' ? <Pause className="size-7" fill="currentColor" /> : <Play className="ml-1 size-7" fill="currentColor" />}
                </span>
              </button>
            )}
          </div>

          {(capturing || phase === 'requesting') && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-danger/40 bg-surface px-4 py-3">
              <p aria-live="polite" className="min-w-0 flex-1 basis-56 text-sm text-text">
                {statusText}
                {capturing && <span className="mt-0.5 block text-xs text-faint">{t('cloud.capture.keepTab')}</span>}
              </p>
              {capturing && (
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={cancel} className="flex-1 sm:flex-none">
                    {t('cloud.capture.cancel')}
                  </Button>
                  {phase !== 'starting' && (
                    <Button
                      size="sm"
                      icon={phase === 'live' ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                      onClick={togglePause}
                      className="flex-1 sm:flex-none"
                    >
                      {phase === 'live' ? t('cloud.capture.pause') : t('cloud.capture.resume')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Square className="size-3.5" fill="currentColor" />}
                    onClick={stop}
                    className="flex-[2] sm:flex-none"
                  >
                    {t('cloud.capture.stop')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---- live chords / how it works / errors */}
        <div>
          {showLive ? (
            <>
              <LiveChordsView session={capture.session} title={title ?? undefined} compact />
              {(phase === 'stopping' || phase === 'saving' || phase === 'done') && <SavingCard />}
            </>
          ) : !tabCapture ? (
            <NoTabCapture url={url} />
          ) : (
            <Card>
              {phase === 'error' && (
                <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/[0.07] p-3 text-sm text-text">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  <span>{errorMessage}</span>
                </div>
              )}
              {phase === 'error' && state.hasRecording ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={capture.retrySave}>
                    {t('cloud.capture.retrySave')}
                  </Button>
                  <Button icon={<Download className="size-4" />} onClick={downloadRecording}>
                    {t('cloud.capture.download')}
                  </Button>
                  <Button variant="ghost" onClick={cancel}>
                    {t('cloud.capture.cancel')}
                  </Button>
                </div>
              ) : (
                <>
                  <h2 className="font-display text-lg font-semibold tracking-tight">{t('cloud.capture.howTitle')}</h2>
                  <ol className="mt-3 space-y-2.5 text-[15px] leading-snug text-muted">
                    {['cloud.capture.step1', 'cloud.capture.step2', 'cloud.capture.step3'].map((key, i) => (
                      <li key={key} className="flex gap-2.5">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 font-mono text-xs text-text">
                          {i + 1}
                        </span>
                        <span className={clsx(i === 1 && 'text-text')}>{t(key)}</span>
                      </li>
                    ))}
                  </ol>
                  <ShareTabIllustration className="mt-4" />
                  <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      variant="primary"
                      disabled={playerStatus !== 'ready' || phase === 'requesting'}
                      icon={phase === 'requesting' ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" fill="currentColor" />}
                      onClick={() => void begin(false)}
                      className="h-12 px-6 text-base"
                    >
                      {position > 0 ? t('cloud.capture.startOver') : t('cloud.capture.start')}
                    </Button>
                    {position > 0 && (
                      <Button
                        disabled={playerStatus !== 'ready' || phase === 'requesting'}
                        onClick={() => void begin(true)}
                        className="h-12 px-5"
                      >
                        {t('cloud.capture.startFrom', { time: formatTime(position) })}
                      </Button>
                    )}
                  </div>
                  {!cloud && signedIn && <p className="mt-3 text-xs text-faint">{t('cloud.capture.guest')}</p>}
                </>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
