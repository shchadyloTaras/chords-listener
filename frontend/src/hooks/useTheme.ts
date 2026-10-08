import { useEffect } from 'react'
import { useApp, type Lang, type ThemePref } from '../store'
import { useMediaQuery } from './useMediaQuery'

export type ResolvedTheme = 'dark' | 'light'

export function useResolvedTheme(): ResolvedTheme {
  const pref = useApp((s) => s.theme)
  const prefersLight = useMediaQuery('(prefers-color-scheme: light)')
  return resolveTheme(pref, prefersLight)
}

export function resolveTheme(pref: ThemePref, prefersLight: boolean): ResolvedTheme {
  if (pref === 'system') return prefersLight ? 'light' : 'dark'
  return pref
}

/** Applies html[data-theme], html[lang] and the browser chrome color. Mount once in App. */
export function useDocumentTheme(pinnedLang?: Lang) {
  const theme = useResolvedTheme()
  const siteLang = useApp((s) => s.lang)
  const lang = pinnedLang ?? siteLang

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.style.colorScheme = theme
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.appendChild(meta)
    }
    meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || (theme === 'dark' ? '#0c0c0e' : '#f6f5f1')
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
}
