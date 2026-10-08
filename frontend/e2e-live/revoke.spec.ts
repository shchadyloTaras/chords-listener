// AC-32 (+ AC-31), live: with admin pages open, the owner revokes the admin with `scripts/admin_grant.py revoke`
// (against the emulator, as docs/CLOUD.md shows it). The server caches the allowlist for 60 s, so within a minute
// (checked once a second from the open page's own «Оновити», real time) every admin read and action is refused with
// exactly the answer an unknown address gets: the open pages withhold the data («Не знайдено»), a save is not
// applied and not journaled, and a reload shows only «Сторінку не знайдено».
import { API, ADMIN_PAGE } from './support/env'
import { adminGrant, callApi, unknownRouteAnswer, type Answer } from './support/backend'
import { getDoc, listDocs } from './support/emulators'
import { expect, signInOnAdminPage, test } from './support/fixtures'
import { everySecondUntil } from './support/time'

const BOUND_S = 60

test('AC-32: a revoked admin is refused within a minute, on every admin read and action of the open pages', async ({ world, browser }) => {
  const context = await browser.newContext()
  const overview = await context.newPage()
  await signInOnAdminPage(overview, world.admin, '#/')
  // the server cached "admin" for this uid at the first admin request (the page's access check, just now); that entry
  // lives 60 s, so a revoke made a few seconds into the session is refused a few seconds before the minute is up
  const signedInAt = Date.now()
  await expect(overview.getByTestId('analyses-total')).toBeVisible()
  // a second open admin tab, its form loaded: the action tried after the revoke
  const settings = await context.newPage()
  await settings.goto(`${ADMIN_PAGE}#/settings`)
  const limits = settings.getByRole('region', { name: 'Типові ліміти' })
  await expect(limits.getByLabel('Аналізи на добу')).toHaveValue('40')
  await settings.waitForTimeout(Math.max(0, signedInAt + 5000 - Date.now())) // pages open for ~5 s before the revoke

  // ---- the owner revokes
  const revokedAt = Date.now() // before the script starts: the bound is counted from the earliest moment
  expect(adminGrant('revoke', world.admin.uid)).toContain(`revoked: ${world.admin.uid}`)
  expect(await getDoc(`adminAllowlist/${world.admin.uid}`)).toBeNull()
  const journalBefore = (await listDocs('adminAudit')).length

  // ---- the open overview's own read, once a second, until it is refused
  const refresh = async (): Promise<Answer> => {
    const response = overview.waitForResponse((r) => r.url() === `${API}/api/admin/overview` && r.request().method() === 'GET')
    await overview.getByRole('button', { name: 'Оновити' }).click()
    const r = await response
    return { status: r.status(), body: (await r.json()) as Record<string, unknown> }
  }
  const refused = await everySecondUntil(refresh, (a) => a.status !== 200, { boundS: BOUND_S, since: revokedAt })
  console.log(
    `AC-32: the open admin page was refused ${refused.seconds.toFixed(1)} s after the revoke (attempt ${refused.attempts}; bound ${BOUND_S} s; ` +
      `${((revokedAt - signedInAt) / 1000 + refused.seconds).toFixed(1)} s after the sign-in that filled the server's 60-s allowlist cache)`,
  )
  expect(refused.ok, JSON.stringify(refused.value)).toBe(true)
  expect(refused.seconds).toBeLessThanOrEqual(BOUND_S)
  expect(refused.value).toEqual(unknownRouteAnswer('/api/admin/overview'))
  await expect(overview.getByRole('alert')).toHaveText('Не знайдено')

  // ---- an action from the other open page: refused the same way, nothing applied
  await limits.getByLabel('Аналізи на добу').fill('39')
  const save = settings.waitForResponse((r) => r.url() === `${API}/api/admin/settings/limits` && r.request().method() === 'PUT')
  await limits.getByRole('button', { name: 'Зберегти ліміти' }).click()
  const saved = await save
  expect({ status: saved.status(), body: await saved.json() }).toEqual(unknownRouteAnswer('/api/admin/settings/limits'))
  await expect(limits.getByRole('alert')).toContainText('Не знайдено')
  expect(await getDoc('adminConfig/settings')).toMatchObject({ limits: { analyses: 40 } })

  // ---- a new read on the open page (search): no data, the same «Не знайдено»
  await overview.goto(`${ADMIN_PAGE}#/users`)
  await overview.getByLabel('Пошук за email').fill(world.user.email)
  const search = overview.waitForResponse((r) => r.url().startsWith(`${API}/api/admin/users?`))
  await overview.getByRole('button', { name: 'Шукати' }).click()
  const searched = await search
  expect({ status: searched.status(), body: await searched.json() }).toEqual(unknownRouteAnswer('/api/admin/users'))
  await expect(overview.getByRole('alert')).toContainText('Не знайдено')
  await expect(overview.getByRole('link', { name: world.user.email })).toHaveCount(0)

  // ---- every other admin route, read or action, with the same account: the unknown-address answer, word for word
  const token = await world.admin.token()
  const uid = world.user.uid
  const day = new Date().toISOString().slice(0, 10)
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/settings'],
    ['GET', `/api/admin/users/${uid}`],
    ['GET', `/api/admin/users/${uid}/tracks`],
    ['GET', '/api/admin/jobs'],
    ['GET', `/api/admin/stats?from=${day}&to=${day}`],
    ['GET', '/api/admin/audit'],
    ['PUT', '/api/admin/settings/switches/youtubeEnabled', { value: false }],
    ['PUT', '/api/admin/settings/banner', { enabled: true, uk: 'x', en: 'x' }],
    ['POST', `/api/admin/users/${uid}/quota/reset`],
    ['PUT', `/api/admin/users/${uid}/limit`, { analyses: 100 }],
    ['DELETE', `/api/admin/users/${uid}/limit`],
    ['PUT', `/api/admin/users/${uid}/restriction`, { reason: 'x' }],
    ['DELETE', `/api/admin/users/${uid}/restriction`],
    ['POST', `/api/admin/users/${uid}/deletion`, { confirmEmail: world.user.email }],
    ['DELETE', `/api/admin/users/${uid}/deletion`],
  ]
  for (const [method, path, json] of routes) {
    const answer = await callApi(path, token, { method, json })
    expect(answer, `${method} ${path}`).toEqual(unknownRouteAnswer(path.split('?')[0]))
  }
  expect(await callApi('/api/admin/no-such-route', token)).toEqual(unknownRouteAnswer('/api/admin/no-such-route'))
  // nothing of it was applied or journaled
  expect((await listDocs('adminAudit')).length).toBe(journalBefore)
  expect(await getDoc(`adminAccounts/${uid}`)).toBeNull()
  expect(await getDoc('publicStatus/current')).toMatchObject({ banner: { enabled: false }, switches: { youtubeEnabled: true } })

  // ---- a reload: the page itself is not found
  await overview.reload()
  await expect(overview.getByRole('heading', { level: 1 })).toHaveText('Сторінку не знайдено')
  await expect(overview.getByRole('navigation', { name: 'Адмінка' })).toHaveCount(0)
  await context.close()
})
