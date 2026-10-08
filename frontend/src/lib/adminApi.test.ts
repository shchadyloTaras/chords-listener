// The admin API client (docs/features/admin, contracts/openapi.yaml): the ID token on every call, one
// re-login + retry on reauth_required (AC-34), error codes → uk/en text incl. «not applied, retry» (AC-33) and
// «data unavailable, retry» (AC-33b), per-field messages for forms. Firebase (lib/auth) is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate } from '../i18n'

const auth = vi.hoisted(() => ({
  getIdToken: vi.fn<(forceRefresh?: boolean) => Promise<string | null>>(),
  requestSignIn: vi.fn<(reason?: string) => Promise<boolean>>(),
}))

vi.mock('./auth', () => ({
  getIdToken: auth.getIdToken,
  requestSignIn: auth.requestSignIn,
  useAuth: { getState: () => ({ user: null, ready: true }), subscribe: () => () => undefined },
}))

import * as admin from './adminApi'

const CLOUD = 'https://chords-api-84488579848.europe-west1.run.app'
const fetchMock = vi.fn<typeof fetch>()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const err = (code: string, status: number, extra: Record<string, unknown> = {}) => json({ detail: `d:${code}`, code, ...extra }, status)

const account = {
  uid: 'u1',
  status: 'normal',
  restriction: null,
  deletion: null,
  personalLimit: null,
  quota: { day: '2026-10-08', analyses: { used: 0, limit: 40 }, vocals: { used: 0, limit: 15 }, jobs: { used: 0, limit: 2 } },
}

function call(i = 0) {
  const [url, init] = fetchMock.mock.calls[i]
  const headers = new Headers((init as RequestInit | undefined)?.headers)
  return { url: String(url), init: (init ?? {}) as RequestInit, headers, body: (init as RequestInit | undefined)?.body }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  auth.getIdToken.mockImplementation(async (force) => (force ? 'tok-fresh' : 'tok-1'))
  auth.requestSignIn.mockResolvedValue(true)
})

afterEach(() => {
  fetchMock.mockReset()
  auth.getIdToken.mockReset()
  auth.requestSignIn.mockReset()
  vi.unstubAllGlobals()
})

describe('requests', () => {
  it('sends the ID token to the cloud API on every call', async () => {
    fetchMock.mockImplementation(async () => json({ day: '2026-10-08' }))
    await admin.getOverview()
    await admin.searchUsers('ivan')
    await admin.getSettings()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i++) {
      expect(call(i).url.startsWith(`${CLOUD}/api/admin/`)).toBe(true)
      expect(call(i).headers.get('Authorization')).toBe('Bearer tok-1')
    }
  })

  it('maps each operation to its route, verb and body', async () => {
    fetchMock.mockImplementation(async () => json({}))
    await admin.getOverview()
    await admin.searchUsers('iv an')
    await admin.getUserCard('u/1')
    await admin.listUserTracks('u1', { after: 'cur', limit: 50 })
    await admin.listJobHistory({ status: 'error', reason: 'youtube_blocked', origin: 'link', from: '2026-10-01', to: '2026-10-08' }, { after: 'c1', limit: 25 })
    await admin.getStats('2026-09-09', '2026-10-08')
    await admin.listAudit({ adminUid: 'a1', targetUid: 'u1', action: 'quota_reset' }, { before: 'c2' })
    await admin.resetQuota('u1')
    await admin.setPersonalLimit('u1', { analyses: 100, until: '2026-10-31' })
    await admin.removePersonalLimit('u1')
    await admin.restrictUser('u1', 'spam')
    await admin.unrestrictUser('u1')
    await admin.scheduleDeletion('u1', 'a@b.c')
    await admin.cancelDeletion('u1')
    await admin.getSettings()
    await admin.setDefaultLimits({ analyses: 30, vocals: 15, jobs: 2, maxDurationMin: 20, maxUploadMb: 500 })
    await admin.setSwitch('analysesPaused', true)
    await admin.setBanner({ enabled: true, uk: 'Робота', en: 'Work' })

    const seen = fetchMock.mock.calls.map((_, i) => {
      const c = call(i)
      return `${c.init.method ?? 'GET'} ${c.url.slice(CLOUD.length)}${c.body ? ` ${c.body as string}` : ''}`
    })
    expect(seen).toEqual([
      'GET /api/admin/overview',
      'GET /api/admin/users?q=iv+an',
      'GET /api/admin/users/u%2F1',
      'GET /api/admin/users/u1/tracks?after=cur&limit=50',
      'GET /api/admin/jobs?status=error&reason=youtube_blocked&origin=link&from=2026-10-01&to=2026-10-08&after=c1&limit=25',
      'GET /api/admin/stats?from=2026-09-09&to=2026-10-08',
      'GET /api/admin/audit?adminUid=a1&targetUid=u1&action=quota_reset&before=c2',
      'POST /api/admin/users/u1/quota/reset',
      'PUT /api/admin/users/u1/limit {"analyses":100,"until":"2026-10-31"}',
      'DELETE /api/admin/users/u1/limit',
      'PUT /api/admin/users/u1/restriction {"reason":"spam"}',
      'DELETE /api/admin/users/u1/restriction',
      'POST /api/admin/users/u1/deletion {"confirmEmail":"a@b.c"}',
      'DELETE /api/admin/users/u1/deletion',
      'GET /api/admin/settings',
      'PUT /api/admin/settings/limits {"analyses":30,"vocals":15,"jobs":2,"maxDurationMin":20,"maxUploadMb":500}',
      'PUT /api/admin/settings/switches/analysesPaused {"value":true}',
      'PUT /api/admin/settings/banner {"enabled":true,"uk":"Робота","en":"Work"}',
    ])
    expect(call(7).headers.get('Content-Type')).toBeNull()
    expect(call(8).headers.get('Content-Type')).toBe('application/json')
  })

  it('returns the parsed JSON body', async () => {
    fetchMock.mockImplementation(async () => json(account))
    expect(await admin.resetQuota('u1')).toEqual(account)
  })

  it('passes the abort signal to fetch', async () => {
    fetchMock.mockImplementation(async () => json({}))
    const ctl = new AbortController()
    await admin.getOverview(ctl.signal)
    expect(call().init.signal).toBe(ctl.signal)
  })
})

describe('session handling', () => {
  it('re-logs in on reauth_required, then repeats the call once with a fresh token (AC-34)', async () => {
    fetchMock.mockImplementationOnce(async () => err('reauth_required', 401)).mockImplementationOnce(async () => json({ ...account, status: 'deletion_scheduled' }))
    const state = await admin.scheduleDeletion('u1', 'a@b.c')
    expect(state.status).toBe('deletion_scheduled')
    expect(auth.requestSignIn).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(call(0).headers.get('Authorization')).toBe('Bearer tok-1')
    expect(call(1).headers.get('Authorization')).toBe('Bearer tok-fresh')
    expect(call(1).body).toBe(call(0).body)
  })

  it('does not repeat the action while the login is not confirmed (dialog dismissed)', async () => {
    auth.requestSignIn.mockResolvedValue(false)
    fetchMock.mockImplementation(async () => err('reauth_required', 401))
    await expect(admin.setSwitch('analysesPaused', true)).rejects.toMatchObject({ code: 'reauth_required', status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries only once when the server still wants a fresher login', async () => {
    fetchMock.mockImplementation(async () => err('reauth_required', 401))
    await expect(admin.scheduleDeletion('u1', 'a@b.c')).rejects.toMatchObject({ code: 'reauth_required' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.requestSignIn).toHaveBeenCalledTimes(1)
  })

  it('renews the token once on unauthorized, without asking for a password', async () => {
    fetchMock.mockImplementationOnce(async () => err('unauthorized', 401)).mockImplementationOnce(async () => json({}))
    await admin.getOverview()
    expect(call(1).headers.get('Authorization')).toBe('Bearer tok-fresh')
    expect(auth.requestSignIn).not.toHaveBeenCalled()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => err('unauthorized', 401))
    await expect(admin.getOverview()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not call the server without a signed-in user', async () => {
    auth.getIdToken.mockResolvedValue(null)
    await expect(admin.getOverview()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('errors', () => {
  it('exposes the code, the status and the server text', async () => {
    fetchMock.mockImplementation(async () => err('self_target', 409))
    const e = await admin.restrictUser('me', 'x').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(admin.AdminApiError)
    expect(e).toMatchObject({ code: 'self_target', status: 409, message: 'd:self_target' })
  })

  it('exposes per-field messages to forms (details.fields)', async () => {
    fetchMock.mockImplementation(async () =>
      err('invalid_value', 422, { details: { fields: { analyses: 'an integer from 1 to 1000', until: 'not before today (UTC)' } } }),
    )
    const e = (await admin.setPersonalLimit('u1', { analyses: 0 }).catch((x: unknown) => x)) as InstanceType<typeof admin.AdminApiError>
    expect(e.code).toBe('invalid_value')
    expect(e.fields).toEqual({ analyses: 'an integer from 1 to 1000', until: 'not before today (UTC)' })
  })

  it('has no fields when the server sent none, and ignores non-string field values', async () => {
    fetchMock.mockImplementationOnce(async () => err('not_set', 409))
    expect(((await admin.removePersonalLimit('u1').catch((x: unknown) => x)) as InstanceType<typeof admin.AdminApiError>).fields).toEqual({})
    fetchMock.mockImplementationOnce(async () => err('invalid_value', 422, { details: { fields: { a: 1, b: 'ok' } } }))
    expect(((await admin.setBanner({ enabled: true, uk: '', en: '' }).catch((x: unknown) => x)) as InstanceType<typeof admin.AdminApiError>).fields).toEqual({ b: 'ok' })
  })

  it('reports an unreachable server and an unknown body as network / http', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(admin.getOverview()).rejects.toMatchObject({ code: 'network', status: 0 })
    fetchMock.mockImplementationOnce(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(admin.getOverview()).rejects.toMatchObject({ code: 'network', status: 502 })
    fetchMock.mockImplementationOnce(async () => new Response('teapot', { status: 418 }))
    await expect(admin.getOverview()).rejects.toMatchObject({ code: 'http', status: 418 })
  })

  it('keeps a request abort as aborted', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(admin.getOverview()).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('error-code texts', () => {
  const NEW_CODES = [
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
  ] as const

  it('covers every new error code, in both languages', () => {
    for (const code of NEW_CODES) {
      expect(admin.ADMIN_ERROR_CODES, code).toContain(code)
      for (const lang of ['uk', 'en'] as const) {
        const text = translate(lang, admin.adminErrorKey(code))
        expect(text, `${lang}:${code}`).not.toBe(admin.adminErrorKey(code))
        expect(text.trim().length, `${lang}:${code}`).toBeGreaterThan(3)
      }
    }
    for (const code of ['unauthorized', 'not_found', 'internal', 'network', 'http'] as const) {
      expect(translate('uk', admin.adminErrorKey(code))).not.toBe(admin.adminErrorKey(code))
    }
  })

  it('says «not applied, retry» when the audit write failed on a change (AC-33)', async () => {
    fetchMock.mockImplementation(async () => err('not_applied', 503))
    const e = await admin.resetQuota('u1').catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'not_applied', status: 503 })
    expect(admin.adminErrorMessage(e, (k) => translate('uk', k))).toBe('Зміну не застосовано, повторіть')
    expect(admin.adminErrorMessage(e, (k) => translate('en', k))).toBe('The change was not applied — try again')
  })

  it('says «data unavailable, retry» when the audit write failed on a view (AC-33b)', async () => {
    fetchMock.mockImplementation(async () => err('audit_unavailable', 503))
    const e = await admin.getUserCard('u1').catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'audit_unavailable', status: 503 })
    expect(admin.adminErrorMessage(e, (k) => translate('uk', k))).toBe('Дані недоступні, повторіть')
  })

  it('falls back to the generic text for anything that is not an admin error', () => {
    expect(admin.adminErrorMessage(new Error('boom'), (k) => translate('en', k))).toBe(translate('en', 'admin.error.internal'))
  })

  it('labels every failure reason in both languages', () => {
    for (const reason of ['youtube_blocked', 'download_failed', 'unsupported_format', 'too_long', 'too_large', 'analysis_failed', 'other']) {
      for (const lang of ['uk', 'en'] as const) {
        const key = `admin.reason.${reason}`
        expect(translate(lang, key), `${lang}:${reason}`).not.toBe(key)
      }
    }
  })
})
