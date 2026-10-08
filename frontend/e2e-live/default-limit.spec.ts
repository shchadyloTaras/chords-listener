// AC-24 (+ AC-10), live: the admin changes the default daily analyses limit 40 → 30 on the Settings screen; within a
// minute (checked once a second in real time) the limit the server reports to a user without a personal limit —
// `GET /api/me`, the user-facing quota endpoint — is 30, and it is enforced: a user who has run 30 analyses today is
// refused the 31st, which the old limit would have admitted. The same server process throughout (no restart, no
// redeploy). The journal shows the old and the new value.
import { API } from './support/env'
import { callApi, seedQuotaUsage, serverLog } from './support/backend'
import { getDoc } from './support/emulators'
import { auditRows, expect, signInOnAdminPage, test } from './support/fixtures'
import { everySecondUntil } from './support/time'

const BOUND_S = 60
type Me = { quotas: { analyses: { used: number; limit: number } } }

test('AC-24: a new default limit applies within a minute without a redeploy, and the journal shows 40 → 30', async ({ world, browser }) => {
  const adminToken = await world.admin.token()
  // the seeded default (migration 04 from CHORDS_QUOTA_ANALYSES=40); the server's settings cache lives ≤ 30 s
  const seeded = await everySecondUntil(
    () => callApi('/api/admin/settings', adminToken),
    (a) => (a.body as { limits?: { analyses?: number } } | null)?.limits?.analyses === 40,
    { boundS: 35 },
  )
  expect(seeded.ok, JSON.stringify(seeded.value.body)).toBe(true)

  // the user (no personal limit) has used 30 analyses today: under the old limit, there are 10 left
  seedQuotaUsage(world.user.uid, 30)
  const userToken = await world.user.token()
  expect(((await callApi('/api/me', userToken)).body as Me).quotas.analyses).toEqual({ used: 30, limit: 40 })
  const starts = serverLog.starts()

  // ---- the admin saves 30 on the Settings screen
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signInOnAdminPage(admin, world.admin, '#/settings')
  const card = admin.getByRole('region', { name: 'Типові ліміти' })
  const field = card.getByLabel('Аналізи на добу')
  await expect(field).toHaveValue('40')
  await field.fill('30')
  const answer = admin.waitForResponse((r) => r.url() === `${API}/api/admin/settings/limits` && r.request().method() === 'PUT')
  await card.getByRole('button', { name: 'Зберегти ліміти' }).click()
  expect((await answer).status()).toBe(200)
  const changedAt = Date.now()
  await expect(card.getByRole('status')).toHaveText('Збережено')
  expect(await getDoc('adminConfig/settings')).toMatchObject({ limits: { analyses: 30 } })

  // ---- the user's limit, as the server reports it, within the bound
  const applied = await everySecondUntil(
    () => callApi('/api/me', userToken),
    (a) => (a.body as Me | null)?.quotas?.analyses?.limit === 30,
    { boundS: BOUND_S, since: changedAt },
  )
  console.log(`AC-24: GET /api/me reported the new limit ${applied.seconds.toFixed(1)} s after the change (attempt ${applied.attempts}; bound ${BOUND_S} s)`)
  expect(applied.ok, JSON.stringify(applied.value.body)).toBe(true)
  expect(applied.seconds).toBeLessThanOrEqual(BOUND_S)
  expect((applied.value.body as Me).quotas.analyses).toEqual({ used: 30, limit: 30 })

  // ... and enforced: the 31st analysis of the day is refused (40 would have admitted it), nothing counted
  const refused = await callApi('/api/jobs', userToken, { method: 'POST', json: { url: `http://127.0.0.1:9/live-e2e-${Date.now()}.mp3` } })
  expect(refused.status, JSON.stringify(refused.body)).toBe(429)
  expect(refused.body).toMatchObject({ code: 'quota_exceeded' })
  expect(String(refused.body?.detail)).toContain('30')
  expect(((await callApi('/api/me', userToken)).body as Me).quotas.analyses.used).toBe(30)
  expect(serverLog.starts(), 'the server was not restarted').toBe(starts)

  // ---- the journal: who changed which setting, from 40 to 30
  const rows = await auditRows(admin)
  const row = rows.find((r) => r.includes('Зміна типових лімітів'))
  expect(row, rows.join('\n')).toBeDefined()
  expect(row).toContain(world.admin.email)
  expect(row).toContain('Типові ліміти')
  expect(row).toContain('analyses: 40 → 30')
  expect(row).toContain('Застосовано')
  await adminContext.close()

  // leave the default as it was for the specs that follow (this also refreshes the server's settings cache)
  const restore = await callApi('/api/admin/settings/limits', adminToken, {
    method: 'PUT',
    json: { analyses: 40, vocals: 15, jobs: 2, maxDurationMin: 30, maxUploadMb: 500 },
  })
  expect(restore.status, JSON.stringify(restore.body)).toBe(200)
})
