import { ArrowLeft } from 'lucide-react'
import { useT } from '../../i18n'
import * as api from '../../lib/api'
import { toApiError } from '../../lib/api'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { navigate, paths } from '../../hooks/useRoute'
import { TrackCover } from '../history/TrackCover'
import { errorText } from '../jobs/errorText'
import { IconButton } from '../ui/IconButton'
import { InlineEdit } from '../ui/InlineEdit'

/** Merge server-side metadata into the loaded track without resetting playback / chord edits. */
function mergeMeta(updated: Pick<Track, 'id' | 'title' | 'artist' | 'edited'>) {
  useApp.setState((s) =>
    s.track && s.track.id === updated.id
      ? { track: { ...s.track, title: updated.title, artist: updated.artist, edited: updated.edited } }
      : {},
  )
}

async function saveMeta(track: Track, patch: { title?: string; artist?: string }, demo: boolean) {
  if (demo) {
    mergeMeta({ ...track, ...patch })
    return
  }
  try {
    mergeMeta(await api.updateTrack(track.id, patch))
  } catch (e) {
    useApp.getState().toast(errorText(toApiError(e).code), 'error')
    throw e
  }
}

/** Header left side on track pages: back, cover, inline-editable title and artist. */
export function TrackTitleBar({ demo }: { demo: boolean }) {
  const t = useT()
  const track = useApp((s) => s.track)

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <IconButton label={t('core.track.back')} onClick={() => navigate(paths.home())} className="-ml-1.5">
        <ArrowLeft className="size-5" />
      </IconButton>
      {track ? (
        <>
          <TrackCover
            title={track.title}
            thumbnail={track.thumbnail}
            keyInfo={track.key}
            className="hidden size-9 rounded-lg sm:flex [&_span]:text-xs"
          />
          <div className="flex min-w-0 flex-1 flex-col items-start leading-tight">
            <InlineEdit
              value={track.title}
              placeholder={t('core.track.untitled')}
              label={t('core.track.rename')}
              onSave={async (title) => {
                await saveMeta(track, { title }, demo)
                useApp.getState().toast(t('core.track.renamed'), 'success')
              }}
              className="font-display text-[15px] font-semibold tracking-tight sm:text-base"
              inputClassName="h-6 font-display text-[15px] font-semibold"
            />
            <InlineEdit
              value={track.artist ?? ''}
              placeholder={t('core.track.addArtist')}
              label={t('core.track.editArtist')}
              onSave={(artist) => saveMeta(track, { artist }, demo)}
              className="text-xs text-muted"
              inputClassName="h-5 text-xs"
            />
          </div>
        </>
      ) : (
        <div className="h-4 w-40 animate-pulse rounded bg-surface-2" aria-hidden="true" />
      )}
    </div>
  )
}
