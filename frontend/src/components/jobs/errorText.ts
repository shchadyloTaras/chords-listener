import type { ClientErrorCode } from '../../lib/api'
import { useConnection } from '../../lib/serverMode'
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

/** Codes of the cloud service (docs/CLOUD.md), worded in i18n/cloud.ts. */
const CLOUD: ReadonlySet<string> = new Set<ClientErrorCode>(['unauthorized', 'quota_exceeded', 'download_blocked', 'unavailable'])

/** Failures whose generic wording talks about "your server": the cloud gets its own. */
const CLOUD_WORDING: ReadonlySet<string> = new Set(['network', 'internal'])

function keyFor(kind: 'error' | 'errorTitle', code: string | null | undefined): string {
  if (code === 'server_required') return `web.${kind}.serverRequired`
  if (code && CLOUD.has(code)) return `cloud.${kind}.${code}`
  const key = code && KNOWN.has(code) ? code : 'internal'
  if (CLOUD_WORDING.has(key) && useConnection.getState().backend === 'cloud') return `cloud.${kind}.${key}`
  return `core.${kind}.${key}`
}

/** Localized, user-facing explanation for an error code (falls back to a generic message). */
export function errorText(code: string | null | undefined, lang: Lang = useApp.getState().lang): string {
  return translate(lang, keyFor('error', code))
}

/** Short localized headline for an error code. */
export function errorTitle(code: string | null | undefined, lang: Lang = useApp.getState().lang): string {
  return translate(lang, keyFor('errorTitle', code))
}
