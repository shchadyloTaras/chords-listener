import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { HardDrive, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import type { TrackSummary } from '../../types'
import { paths } from '../../hooks/useRoute'
import { Button, IconButton } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { formatRelative, formatTime, pluralCategory } from '../ui/format'
import { isLocalId } from '../../lib/local'
import { useConnection } from '../../lib/serverMode'
import { refreshTracks, scheduleDelete, useTracks } from './tracksStore'
import { TrackCover } from './TrackCover'
import { BpmTag } from '../chords/tempo/BpmTag'
import { resolveSpelling, transposeKeyName } from '../../lib/music/key'

function TrackRow({ track }: { track: TrackSummary }) {
  const t = useT()
  // browser-analyzed tracks are marked only when the server's library is listed alongside
  const withServer = useConnection((s) => s.status === 'server')
  const lang = useApp((s) => s.lang)
  const accidentals = useApp((s) => s.accidentals)
  const subtitle = track.artist || (track.source.type === 'file' ? track.source.filename : null)
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
      className="group relative"
    >
      <a
        href={`#${paths.track(track.id)}`}
        className={clsx(
          'flex items-center gap-3 rounded-xl py-2 pr-12 pl-2 transition-colors duration-150 sm:gap-4',
          'hover:bg-surface-2 focus-visible:bg-surface-2',
        )}
      >
        <TrackCover
          title={track.title}
          thumbnail={track.thumbnail}
          keyInfo={track.key}
          source={track.source}
          className="h-12 w-[4.5rem] rounded-lg sm:h-14 sm:w-24"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-text">{track.title}</span>
            {track.edited && (
              <span
                title={t('core.history.editedHint')}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent"
              >
                <Pencil className="size-2.5" aria-hidden="true" />
                {t('core.history.edited')}
              </span>
            )}
            {withServer && isLocalId(track.id) && (
              <span
                title={t('web.history.localHint')}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-3 px-1.5 py-1 text-[11px] font-medium text-muted sm:py-0.5"
              >
                <HardDrive className="size-2.5" aria-hidden="true" />
                {/* phones: icon only, the title needs the room */}
                <span className="sr-only sm:not-sr-only">{t('web.history.local')}</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-sm text-muted">
            {track.source.type === 'youtube' && <VideoSiteIcon className="size-3.5 text-faint" />}
            <span className="truncate">{subtitle || formatRelative(track.createdAt, lang)}</span>
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          {track.key?.name && (
            <span
              title={t('core.history.key')}
              className="rounded-md border border-border px-1.5 py-0.5 font-display text-sm font-semibold text-text"
            >
              {/* spelled like on the track page: Ab major, not G# */}
              {transposeKeyName(track.key, 0, resolveSpelling(accidentals, track.key)) ?? track.key.name}
            </span>
          )}
          <BpmTag trackId={track.id} tempo={track.tempo} className="w-16 text-right" />
          <span className="w-12 text-right font-mono text-xs text-muted tabular-nums">{formatTime(track.duration)}</span>
        </div>
      </a>
      <IconButton
        label={t('core.history.delete', { title: track.title })}
        size="sm"
        onClick={() => scheduleDelete(track.id, track.title)}
        className="absolute top-1/2 right-2 -translate-y-1/2 opacity-100 hover:text-danger sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
      >
        <Trash2 className="size-4" />
      </IconButton>
    </motion.li>
  )
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="space-y-1">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-4 p-2">
          <div className="h-14 w-24 animate-pulse rounded-lg bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-surface-2" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Recent tracks from GET /api/tracks — open on click, delete with Undo. */
export function RecentTracks() {
  const t = useT()
  const tracks = useTracks((s) => s.tracks)
  const error = useTracks((s) => s.error)
  const loading = useTracks((s) => s.loading)
  const pending = useTracks((s) => s.pendingDelete)
  const lang = useApp((s) => s.lang)
  const mode = useConnection((s) => s.status)

  // Load once the mode is known, and again whenever the server comes or goes
  // (browser-mode tracks live in IndexedDB and are listed in every mode).
  useEffect(() => {
    if (mode !== 'checking') void refreshTracks()
  }, [mode])

  const visible = useMemo(() => tracks?.filter((tr) => !pending[tr.id]) ?? null, [tracks, pending])

  if (visible === null) {
    if (error)
      return (
        <section className="mt-14">
          <p className="text-sm text-muted">{t('core.history.loadFailed')}</p>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2 -ml-3"
            icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />}
            onClick={() => void refreshTracks()}
          >
            {t('core.retry')}
          </Button>
        </section>
      )
    return (
      <section className="mt-14">
        <SkeletonRows />
      </section>
    )
  }

  if (!visible.length) {
    return (
      <section className="mt-14 rounded-2xl border border-dashed border-border-strong px-6 py-8 text-center">
        <p className="text-sm text-muted">{t('core.history.empty')}</p>
        <a href={`#${paths.demo()}`} className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
          {t('core.history.tryDemo')}
        </a>
      </section>
    )
  }

  return (
    <section className="mt-14" aria-labelledby="recent-heading">
      <div className="mb-2 flex items-baseline justify-between px-2">
        <h2 id="recent-heading" className="font-display text-lg font-semibold tracking-tight">
          {t('core.history.title')}
        </h2>
        <span className="text-sm text-faint">{t(`core.history.count.${pluralCategory(lang, visible.length)}`, { n: visible.length })}</span>
      </div>
      <ul className="space-y-0.5">
        <AnimatePresence initial={false}>
          {visible.map((tr) => (
            <TrackRow key={tr.id} track={tr} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  )
}
