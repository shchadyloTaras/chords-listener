import clsx from 'clsx'
import { CircleHelp, Keyboard, Monitor, Moon, Sun } from 'lucide-react'
import { useT } from '../../i18n'
import { useApp, type Lang, type ThemePref } from '../../store'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem } from '../ui/Menu'

const THEME_ICONS: Record<ThemePref, typeof Moon> = { dark: Moon, light: Sun, system: Monitor }
const LANGS: Array<{ value: Lang; label: string; name: string }> = [
  { value: 'uk', label: 'UA', name: 'Українська' },
  { value: 'en', label: 'EN', name: 'English' },
]

export function LangSwitch() {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const setSetting = useApp((s) => s.setSetting)
  return (
    <div role="group" aria-label={t('core.settings.language')} className="flex h-8 items-center rounded-lg bg-surface-2 p-0.5">
      {LANGS.map((l) => (
        <button
          key={l.value}
          type="button"
          lang={l.value}
          aria-pressed={lang === l.value}
          title={l.name}
          onClick={() => setSetting('lang', l.value)}
          className={clsx(
            'h-7 rounded-md px-2 text-xs font-semibold transition-colors duration-150',
            lang === l.value ? 'bg-surface-3 text-text shadow-sm' : 'text-faint hover:text-text',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}

export function ThemeMenu() {
  const t = useT()
  const theme = useApp((s) => s.theme)
  const setSetting = useApp((s) => s.setSetting)
  const Icon = THEME_ICONS[theme]
  return (
    <Menu
      label={t('core.settings.theme')}
      trigger={(props) => (
        <IconButton {...props} label={`${t('core.settings.theme')}: ${t(`core.theme.${theme}`)}`}>
          <Icon className="size-[18px]" />
        </IconButton>
      )}
    >
      {(['dark', 'light', 'system'] as const).map((value) => {
        const ItemIcon = THEME_ICONS[value]
        return (
          <MenuItem key={value} icon={<ItemIcon />} checked={theme === value} onSelect={() => setSetting('theme', value)}>
            {t(`core.theme.${value}`)}
          </MenuItem>
        )
      })}
    </Menu>
  )
}

export function HelpButton({ onHelp }: { onHelp(): void }) {
  const t = useT()
  return (
    <IconButton label={t('core.shortcuts.title')} hint="?" onClick={onHelp}>
      <Keyboard className="size-[18px]" />
    </IconButton>
  )
}

/** «Інструкція»: the current screen's guided tour (desktop header, right after the shortcuts button). */
export function GuideButton({ onGuide }: { onGuide(): void }) {
  const t = useT()
  return (
    <IconButton label={t('tour.open')} onClick={onGuide}>
      <CircleHelp className="size-[18px]" />
    </IconButton>
  )
}
