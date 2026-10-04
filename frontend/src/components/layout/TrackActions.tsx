import { ExternalLink, Keyboard, Monitor, Moon, MoreHorizontal, RefreshCw, Sun, Trash2 } from 'lucide-react'
import { useT } from '../../i18n'
import { toApiError } from '../../lib/api'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { reanalyze } from '../../hooks/useJobs'
import { navigate, paths } from '../../hooks/useRoute'
import { scheduleDelete } from '../history/tracksStore'
import { errorText } from '../jobs/errorText'
import { sourceHref } from '../player/trackSource'
import { IconButton } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu'

/** Link to the original video / page (desktop header). */
export function SourceLink({ track }: { track: Track }) {
  const t = useT()
  const href = sourceHref(track)
  if (!href) return null
  const isYt = track.source.type === 'youtube'
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={isYt ? t('core.track.openYoutube') : t('core.track.openSource')}
      aria-label={isYt ? t('core.track.openYoutube') : t('core.track.openSource')}
      className="inline-flex size-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-3 hover:text-text"
    >
      {isYt ? <VideoSiteIcon className="size-[18px]" /> : <ExternalLink className="size-[18px]" />}
    </a>
  )
}

interface HeaderMenuProps {
  track: Track | null
  demo: boolean
  /** include theme / language / shortcuts (phones, where they are not in the header) */
  withSettings: boolean
  onHelp(): void
}

/** Overflow menu: track actions (source, re-analyze, delete) and, on phones, app settings. */
export function HeaderMenu({ track, demo, withSettings, onHelp }: HeaderMenuProps) {
  const t = useT()
  const theme = useApp((s) => s.theme)
  const lang = useApp((s) => s.lang)
  const setSetting = useApp((s) => s.setSetting)
  const href = track ? sourceHref(track) : null
  const canEdit = Boolean(track) && !demo

  return (
    <Menu
      label={t('core.menu.more')}
      trigger={(props) => (
        <IconButton {...props} label={t('core.menu.more')}>
          <MoreHorizontal className="size-5" />
        </IconButton>
      )}
    >
      {track && (
        <>
          {href && (
            <MenuItem
              icon={track.source.type === 'youtube' ? <VideoSiteIcon /> : <ExternalLink />}
              onSelect={() => window.open(href, '_blank', 'noopener,noreferrer')}
            >
              {track.source.type === 'youtube' ? t('core.track.openYoutube') : t('core.track.openSource')}
            </MenuItem>
          )}
          {canEdit && (
            <MenuItem
              icon={<RefreshCw />}
              onSelect={() => {
                reanalyze(track.id).catch((e) =>
                  useApp.getState().toast(errorText(toApiError(e).code), 'error'),
                )
              }}
            >
              {t('core.track.reanalyze')}
            </MenuItem>
          )}
          {canEdit && (
            <MenuItem
              icon={<Trash2 />}
              danger
              onSelect={() => {
                scheduleDelete(track.id, track.title)
                navigate(paths.home())
              }}
            >
              {t('core.track.delete')}
            </MenuItem>
          )}
        </>
      )}
      {withSettings && (
        <>
          {track && (href || canEdit) && <MenuSeparator />}
          <MenuLabel>{t('core.settings.theme')}</MenuLabel>
          <MenuItem icon={<Moon />} checked={theme === 'dark'} onSelect={() => setSetting('theme', 'dark')} keepOpen>
            {t('core.theme.dark')}
          </MenuItem>
          <MenuItem icon={<Sun />} checked={theme === 'light'} onSelect={() => setSetting('theme', 'light')} keepOpen>
            {t('core.theme.light')}
          </MenuItem>
          <MenuItem icon={<Monitor />} checked={theme === 'system'} onSelect={() => setSetting('theme', 'system')} keepOpen>
            {t('core.theme.system')}
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>{t('core.settings.language')}</MenuLabel>
          <MenuItem checked={lang === 'uk'} onSelect={() => setSetting('lang', 'uk')} keepOpen>
            Українська
          </MenuItem>
          <MenuItem checked={lang === 'en'} onSelect={() => setSetting('lang', 'en')} keepOpen>
            English
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Keyboard />} onSelect={onHelp} hint="?">
            {t('core.shortcuts.title')}
          </MenuItem>
        </>
      )}
    </Menu>
  )
}
