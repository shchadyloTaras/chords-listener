// Typed client for the admin API (/api/admin/*, docs/features/admin/contracts/openapi.yaml).
//
// Admin calls go to the cloud API only (the admin page has no local mode, no connection probe): every call carries
// the Firebase ID token. Two session cases, as in lib/api.ts but narrower:
//  · 401 `unauthorized` — the token may just have expired: renew it once and repeat, then give up;
//  · 401 `reauth_required` — the server wants a login not older than 15 minutes (AC-34): ask for the password
//    (the account dialog), and repeat the call once with a fresh token. The server refuses before it changes
//    anything, so repeating is safe. A dismissed dialog leaves the action undone.
// Errors are AdminApiError: the ErrorCode, the HTTP status and, for form validation (422 `invalid_value`),
// the per-field messages in `fields`. `adminErrorMessage` turns one into text for the interface language.
import type { AdminAccountState, AdminAuditEntry, AdminAuditFilters, AdminBanner, AdminDefaultLimits, AdminJobFilters, AdminJobHistoryPage, AdminOverview, AdminPage, AdminPaging, AdminPersonalLimitInput, AdminSettings, AdminStatsRange, AdminSwitchName, AdminTrackMeta, AdminUserCard, AdminUserSearchResult, ErrorCode } from '../types'
import { translate } from '../i18n'
import { getIdToken, requestSignIn } from './auth'
import { cloudPrefix } from './serverMode'

/** What the admin client reports: the server's ErrorCode plus the two it makes up itself. */
export type AdminErrorCode = ErrorCode | 'network' | 'aborted' | 'http'

/** Every code the admin screens may show a text for (i18n/admin.ts has `admin.error.<code>` for each). */
export const ADMIN_ERROR_CODES: readonly AdminErrorCode[] = [
  'cloud_restricted',
  'analyses_paused',
  'youtube_disabled',
  'vocals_disabled',
  'query_too_short',
  'invalid_period',
  'invalid_value',
  'confirm_email_mismatch',
  'reauth_required',
  'self_target',
  'deletion_pending',
  'not_scheduled',
  'not_set',
  'deletion_rate_limit',
  'not_applied',
  'audit_unavailable',
  'unauthorized',
  'not_found',
  'internal',
  'network',
  'aborted',
  'http',
]

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  ...ADMIN_ERROR_CODES,
  'invalid_url',
  'download_failed',
  'unsupported_format',
  'too_long',
  'too_large',
  'analysis_failed',
  'quota_exceeded',
  'download_blocked',
  'unavailable',
  'cancelled',
])

export class AdminApiError extends Error {
  readonly code: AdminErrorCode
  readonly status: number
  /** form field (camelCase, as in the request) → what is allowed; empty unless the server sent `details.fields` */
  readonly fields: Record<string, string>

  constructor(message: string, code: AdminErrorCode, status = 0, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
    this.status = status
    this.fields = fields
  }
}

/** i18n key of the text for an error code (`admin.error.<code>`; codes without their own text use the generic one). */
export function adminErrorKey(code: AdminErrorCode): string {
  return (ADMIN_ERROR_CODES as readonly string[]).includes(code) ? `admin.error.${code}` : 'admin.error.internal'
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

const translateUk: Translate = (key, vars) => translate('uk', key, vars)

/** The text for any thrown value; the admin page is Ukrainian (ADR-0002), so `translate` defaults to Ukrainian. */
export function adminErrorMessage(err: unknown, translate_: Translate = translateUk): string {
  return translate_(err instanceof AdminApiError ? adminErrorKey(err.code) : 'admin.error.internal')
}

function fieldsOf(body: unknown): Record<string, string> {
  const raw = (body as { details?: { fields?: unknown } } | null)?.details?.fields
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [name, text] of Object.entries(raw)) if (typeof text === 'string') out[name] = text
  }
  return out
}

async function errorFromResponse(res: Response): Promise<AdminApiError> {
  const status = res.status
  let detail = res.statusText || `HTTP ${status}`
  let code: AdminErrorCode | null = null
  let fields: Record<string, string> = {}
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object') {
      const b = body as { detail?: unknown; code?: unknown }
      if (typeof b.detail === 'string') detail = b.detail
      if (typeof b.code === 'string' && KNOWN_CODES.has(b.code)) code = b.code as AdminErrorCode
      fields = fieldsOf(body)
    }
  } catch {
    /* non-JSON body */
  }
  if (!code) {
    if (status === 502 || status === 503 || status === 504) code = 'network'
    else if (status === 401) code = 'unauthorized'
    else if (status === 404) code = 'not_found'
    else if (status >= 500) code = 'internal'
    else code = 'http'
  }
  return new AdminApiError(detail, code, status, fields)
}

async function fetchOnce(path: string, init: RequestInit, forceRefresh: boolean): Promise<Response> {
  const prefix = cloudPrefix()
  if (!prefix) throw new AdminApiError('No cloud API is configured', 'network')
  let token: string | null = null
  try {
    token = await getIdToken(forceRefresh)
  } catch {
    // Firebase unreachable: same as signed out
  }
  if (!token) throw new AdminApiError('Not signed in', 'unauthorized', 401)
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)
  try {
    return await fetch(prefix + path, { ...init, headers })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new AdminApiError('Request aborted', 'aborted')
    throw new AdminApiError(err instanceof Error ? err.message : String(err), 'network')
  }
}

/** The error code of a 401 answer, read without consuming the response. */
async function codeOf(res: Response): Promise<AdminErrorCode> {
  return (await errorFromResponse(res.clone())).code
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await fetchOnce(path, init, false)
  if (res.status === 401) {
    const code = await codeOf(res)
    if (code === 'reauth_required') {
      // a fresh login is needed: the dialog signs in again, then the call is repeated once with the new token
      if (await requestSignIn('expired')) res = await fetchOnce(path, init, true)
    } else {
      res = await fetchOnce(path, init, true)
    }
  }
  if (!res.ok) throw await errorFromResponse(res)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') q.set(name, String(value))
  const text = q.toString()
  return text ? `?${text}` : ''
}

function body(method: 'PUT' | 'POST', value: unknown): RequestInit {
  return { method, body: JSON.stringify(value) }
}

const enc = encodeURIComponent
const user = (uid: string) => `/api/admin/users/${enc(uid)}`

// ---------------------------------------------------------------- Stage 1 — view

export function getOverview(signal?: AbortSignal): Promise<AdminOverview> {
  return request('/api/admin/overview', { signal })
}

/** Part of an email, matched anywhere, case-insensitively; at least 3 characters. Journaled by the server (AC-33b). */
export function searchUsers(q: string, signal?: AbortSignal): Promise<AdminUserSearchResult> {
  return request(`/api/admin/users${query({ q })}`, { signal })
}

/** Profile, quota, limit, state, recent jobs and the first page of tracks. Journaled by the server (AC-33b). */
export function getUserCard(uid: string, signal?: AbortSignal): Promise<AdminUserCard> {
  return request(user(uid), { signal })
}

export function listUserTracks(uid: string, paging: AdminPaging = {}, signal?: AbortSignal): Promise<AdminPage<AdminTrackMeta>> {
  return request(`${user(uid)}/tracks${query({ ...paging })}`, { signal })
}

export function listJobHistory(filters: AdminJobFilters = {}, paging: AdminPaging = {}, signal?: AbortSignal): Promise<AdminJobHistoryPage> {
  return request(`/api/admin/jobs${query({ ...filters, ...paging })}`, { signal })
}

export function getStats(from: string, to: string, signal?: AbortSignal): Promise<AdminStatsRange> {
  return request(`/api/admin/stats${query({ from, to })}`, { signal })
}

export function listAudit(filters: AdminAuditFilters = {}, paging: AdminPaging = {}, signal?: AbortSignal): Promise<AdminPage<AdminAuditEntry>> {
  return request(`/api/admin/audit${query({ ...filters, ...paging })}`, { signal })
}

// ---------------------------------------------------------------- Stage 2 — actions on users

export function resetQuota(uid: string): Promise<AdminAccountState> {
  return request(`${user(uid)}/quota/reset`, { method: 'POST' })
}

export function setPersonalLimit(uid: string, limit: AdminPersonalLimitInput): Promise<AdminAccountState> {
  return request(`${user(uid)}/limit`, body('PUT', limit))
}

export function removePersonalLimit(uid: string): Promise<AdminAccountState> {
  return request(`${user(uid)}/limit`, { method: 'DELETE' })
}

export function restrictUser(uid: string, reason: string): Promise<AdminAccountState> {
  return request(`${user(uid)}/restriction`, body('PUT', { reason }))
}

export function unrestrictUser(uid: string): Promise<AdminAccountState> {
  return request(`${user(uid)}/restriction`, { method: 'DELETE' })
}

/** Needs a login not older than 15 minutes: the client asks for the password and repeats once (AC-34). */
export function scheduleDeletion(uid: string, confirmEmail: string): Promise<AdminAccountState> {
  return request(`${user(uid)}/deletion`, body('POST', { confirmEmail }))
}

export function cancelDeletion(uid: string): Promise<AdminAccountState> {
  return request(`${user(uid)}/deletion`, { method: 'DELETE' })
}

// ---------------------------------------------------------------- Stage 3 — settings

export function getSettings(signal?: AbortSignal): Promise<AdminSettings> {
  return request('/api/admin/settings', { signal })
}

export function setDefaultLimits(limits: AdminDefaultLimits): Promise<AdminSettings> {
  return request('/api/admin/settings/limits', body('PUT', limits))
}

/** Turning `analysesPaused` on needs a fresh login (AC-34), handled like scheduleDeletion. */
export function setSwitch(name: AdminSwitchName, value: boolean): Promise<AdminSettings> {
  return request(`/api/admin/settings/switches/${enc(name)}`, body('PUT', { value }))
}

export function setBanner(banner: AdminBanner): Promise<AdminSettings> {
  return request('/api/admin/settings/banner', body('PUT', banner))
}
