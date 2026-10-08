import { useCallback } from 'react'
import { pinLanguage, translate } from '../i18n'

/** The admin page is Ukrainian whatever the site language is (ADR-0002): the admin is the owner. */
export const ADMIN_LANG = 'uk' as const

/** Makes the shared parts of the site the admin page renders (the sign-in dialog, toasts, «Сторінку не знайдено»)
 *  Ukrainian too, without touching the site language stored for the main site. admin.html's entry calls it first. */
export function pinAdminLanguage(): void {
  pinLanguage(ADMIN_LANG)
}

/** Like `useT`, but always Ukrainian, so error texts and labels never mix languages on one page. */
export function useAdminT() {
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(ADMIN_LANG, key, vars), [])
}

/** Text input / select shared by the admin forms. */
export const INPUT_CLASS =
  'h-10 w-full rounded-xl border border-border-strong bg-surface-3 px-3 text-sm text-text aria-[invalid=true]:border-danger'
