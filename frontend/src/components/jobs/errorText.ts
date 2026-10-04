import type { ClientErrorCode } from '../../lib/api'
import { translate } from '../../i18n'
import type { Lang } from '../../store'
import { useApp } from '../../store'

const KNOWN: ReadonlySet<string> = new Set<ClientErrorCode>([
  'invalid_url',
  'download_failed',
  'unsupported_format',
  'too_long',
  'too_large',
  'analysis_failed',
  'not_found',
  'internal',
  'network',
  'aborted',
  'http',
])

/** Localized, user-facing explanation for an error code (falls back to a generic message). */
export function errorText(code: string | null | undefined, lang: Lang = useApp.getState().lang): string {
  if (code === 'server_required') return translate(lang, 'web.error.serverRequired')
  const key = code && KNOWN.has(code) ? code : 'internal'
  return translate(lang, `core.error.${key}`)
}

/** Short localized headline for an error code. */
export function errorTitle(code: string | null | undefined, lang: Lang = useApp.getState().lang): string {
  if (code === 'server_required') return translate(lang, 'web.errorTitle.serverRequired')
  const key = code && KNOWN.has(code) ? code : 'internal'
  return translate(lang, `core.errorTitle.${key}`)
}
