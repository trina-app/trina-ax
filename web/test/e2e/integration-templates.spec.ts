// Connection templates against the mock server (components/integrations/TemplatesView.tsx, IntegrationDialog.tsx): an
// admin registers a service once as a template (no key) for some members; the member sees it under "From your team",
// connects it with their own key, and it works like their own connection (only the key and write rule are theirs to
// change); the admin sees "Template · 1 connected", never the key. A new address drops the members' keys; deleting the
// template removes their connections. Phone width and accessibility in both themes.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const KEY = 'member-own-' + 'k'.repeat(24)
const BOB = { username: 'bob', password: 'bob password 1' }
const modal = (page: Page) => page.getByRole('dialog').filter({ hasNot: page.getByTestId('settings-menu') })

async function makeTemplate(page: Page, o: { name?: string; url?: string } = {}) {
  await page.goto('/admin/integrations')
  await page.getByTestId('integration-add').click()
  const d = modal(page)
  // a new connection is for the team with one key unless the admin picks a template
  await expect(page.getByTestId('integration-who-team')).toBeChecked()
  await page.getByTestId('integration-who-template').check()
  // a template takes no key, and has no write rule (each member's own)
  await expect(page.getByTestId('integration-key')).toHaveCount(0)
  await expect(page.getByTestId('integration-write-ask')).toHaveCount(0)
  await page.getByTestId('integration-name').fill(o.name ?? 'Tasks')
  await page.getByTestId('integration-url').fill(o.url ?? 'https://mcp.tasks.example/mcp')
  // "no sign-in" is not offered for a template
  await expect(page.getByTestId('integration-auth-none')).toHaveCount(0)
  await page.getByTestId('integration-auth-key').check()
  await expect(page.getByTestId('integration-template-key-note')).toBeVisible()
  await page.getByTestId('integration-notes').fill('Use the key from your Tasks profile.')
  await page.getByTestId('integration-access-pick').check()
  await d.getByTestId('integration-access-user').filter({ hasText: 'Bob' }).or(d.getByRole('checkbox', { name: /Bob/ })).first().check()
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/admin/integration-templates') && r.method() === 'POST')
  await page.getByTestId('integration-save').click()
  const body = (await sent).postDataJSON()
  expect(body).toMatchObject({ kind: 'mcp', name: o.name ?? 'Tasks', auth: 'bearer', notes: 'Use the key from your Tasks profile.', access: { everyone: false, users: expect.arrayContaining(['bob']) } })
  expect(body).not.toHaveProperty('secret')
  await expect(modal(page)).toHaveCount(0)
}

test('admin makes a template; the member connects their own key; the admin sees a count, never the key', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  // page errors only: Bob's Home asks for a folder he may not open (a 404 the browser logs, not this page's)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await signIn(page)
  await makeTemplate(page)
  const row = page.getByTestId('template-admin-row').filter({ hasText: 'Tasks' })
  await expect(row.getByTestId('template-badge')).toHaveText('Template · 0 connected')
  await expect(row.getByTestId('template-admin-line')).toContainText('Bob')

  // Bob: "From your team" with the template and Connect
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/settings/integrations')
  const group = page.getByTestId('integrations-from-team')
  await expect(group).toContainText('From your team')
  const tpl = group.getByTestId('template-row').filter({ hasText: 'Tasks' })
  await expect(tpl).toContainText('Use the key from your Tasks profile.')
  await tpl.getByTestId('template-connect').click()
  const d = modal(page)
  await expect(d.getByRole('heading', { name: 'Connect Tasks' })).toBeVisible()
  // where the key goes is said plainly before the key field
  await expect(page.getByTestId('integration-answer-host-warning')).toContainText('mcp.tasks.example')
  await expect(page.getByTestId('integration-answer-decline')).toHaveCount(0)
  await page.getByTestId('integration-answer-key').fill(KEY)
  const sent = page.waitForRequest((r) => /\/api\/integration-templates\/[^/]+\/connect$/.test(r.url()))
  await page.getByTestId('integration-answer-connect').click()
  // the template's version as Bob saw it goes along: changed since, the server refuses (409)
  expect((await sent).postDataJSON()).toEqual({ secret: KEY, writePolicy: 'ask', version: 1 })
  // it is Bob's own connection now, in the same group (not under his own list)
  const conn = group.getByTestId('integration-row').filter({ hasText: 'Tasks' })
  await expect(conn).toHaveAttribute('data-scope', 'personal')
  await expect(group.getByTestId('template-row')).toHaveCount(0)
  await expect(page.getByTestId('integrations-mine').getByText('Tasks')).toHaveCount(0)
  // editing it: only the key and the write rule are his
  await conn.getByTestId('integration-toggle').click()
  await conn.getByRole('button', { name: /Edit/ }).click()
  await expect(page.getByTestId('integration-from-team')).toBeVisible()
  await expect(page.getByTestId('integration-name')).toHaveCount(0)
  await expect(page.getByTestId('integration-url')).toHaveCount(0)
  await expect(page.getByTestId('integration-write-ask')).toBeVisible()
  await modal(page).getByRole('button', { name: 'Cancel' }).click()

  // the owner: one connected, and the key is nowhere
  await page.context().clearCookies()
  await signIn(page)
  const admin = page.waitForResponse((r) => r.url().endsWith('/api/admin/integration-templates') && r.request().method() === 'GET')
  await page.goto('/admin/integrations')
  expect(await (await admin).text()).not.toContain(KEY)
  await expect(page.getByTestId('template-admin-row').filter({ hasText: 'Tasks' }).getByTestId('template-badge')).toHaveText('Template · 1 connected')
  expect(errors).toEqual([])
})

test('a new address drops the members\' keys; deleting the template removes their connections', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await makeTemplate(page)
  // Bob connects
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/settings/integrations')
  await page.getByTestId('template-row').filter({ hasText: 'Tasks' }).getByTestId('template-connect').click()
  await page.getByTestId('integration-answer-key').fill(KEY)
  await page.getByTestId('integration-answer-connect').click()
  await expect(page.getByTestId('integrations-from-team').getByTestId('integration-row')).toHaveCount(1)

  // the owner moves it: the dialog warns that keys go
  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/admin/integrations')
  await page.getByTestId('template-admin-row').filter({ hasText: 'Tasks' }).getByTestId('template-edit').click()
  await expect(modal(page).getByRole('heading', { name: 'Edit template' })).toBeVisible()
  await page.getByTestId('integration-url').fill('https://mcp.tasks2.example/mcp')
  await expect(page.getByTestId('integration-template-drop-warning')).toContainText('1 member has connected')
  await page.getByTestId('integration-save').click()
  await expect(page.getByTestId('template-admin-row').filter({ hasText: 'Tasks' }).getByTestId('template-badge')).toHaveText('Template · 0 connected')

  // Bob connects again, then the owner deletes the template
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/settings/integrations')
  const tpl = page.getByTestId('template-row').filter({ hasText: 'Tasks' })
  await expect(tpl).toBeVisible()
  await tpl.getByTestId('template-connect').click()
  await expect(page.getByTestId('integration-answer-host-warning')).toContainText('mcp.tasks2.example')
  await page.getByTestId('integration-answer-key').fill(KEY)
  await page.getByTestId('integration-answer-connect').click()
  await expect(page.getByTestId('integrations-from-team').getByTestId('integration-row')).toHaveCount(1)

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/admin/integrations')
  await page.getByTestId('template-admin-row').filter({ hasText: 'Tasks' }).getByTestId('template-delete').click()
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog'))).toContainText('1 member\'s connection and key are deleted too.')
  await page.getByRole('button', { name: 'Delete' }).last().click()
  await expect(page.getByTestId('template-admin-row')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/settings/integrations')
  await expect(page.getByTestId('integrations-from-team')).toHaveCount(0)
})

test('a member can disconnect; at phone width the group and Connect still work', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await makeTemplate(page)
  await page.context().clearCookies()
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, BOB)
  await page.goto('/settings/integrations')
  const tpl = page.getByTestId('template-row').filter({ hasText: 'Tasks' })
  await expect(tpl.getByTestId('template-connect')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await tpl.getByTestId('template-connect').click()
  await page.getByTestId('integration-answer-key').fill(KEY)
  await page.getByTestId('integration-answer-connect').click()
  const conn = page.getByTestId('integrations-from-team').getByTestId('integration-row')
  await expect(conn).toHaveCount(1)
  await conn.getByTestId('integration-toggle').click()
  await conn.getByRole('button', { name: /Delete|Disconnect/ }).first().click()
  await page.getByRole('button', { name: 'Delete' }).last().click()
  // back to Connect
  await expect(page.getByTestId('template-row').filter({ hasText: 'Tasks' })).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`templates have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await makeTemplate(page)
    const axe = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    expect(await axe()).toEqual([])
    // the admin's dialog with the template choice open
    await page.getByTestId('integration-add').click()
    await page.getByTestId('integration-who-template').check()
    expect(await axe()).toEqual([])
    await modal(page).getByRole('button', { name: 'Cancel' }).click()
    await page.context().clearCookies()
    await signIn(page, BOB)
    await page.goto('/settings/integrations')
    await expect(page.getByTestId('template-row')).toHaveCount(1)
    expect(await axe()).toEqual([])
    await page.getByTestId('template-connect').click()
    expect(await axe()).toEqual([])
  })
}

test('a template that changed while the dialog was open is refused, then shown as it is now', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await makeTemplate(page)
  const tid = (await (await page.request.get('/api/admin/integration-templates')).json()).items.find((x: { name: string }) => x.name === 'Tasks').id
  // the admin keeps a window open to change the template while Bob connects
  const admin = await browser.newContext()
  const ap = await admin.newPage()
  await signIn(ap)
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/settings/integrations')
  await page.getByTestId('integrations-from-team').getByTestId('template-row').filter({ hasText: 'Tasks' }).getByTestId('template-connect').click()
  await expect(page.getByTestId('integration-answer-host-warning')).toContainText('mcp.tasks.example')
  const moved = await ap.request.patch(`/api/admin/integration-templates/${tid}`, { data: { url: 'https://mcp.other.example/mcp' }, headers: { 'x-mycel-csrf': '1' } })
  expect(moved.ok()).toBe(true)
  await page.getByTestId('integration-answer-key').fill(KEY)
  await page.getByTestId('integration-answer-connect').click()
  // refused, and the dialog now says where the key would go
  await expect(modal(page)).toContainText('바뀌었어요')
  await expect(page.getByTestId('integration-answer-host-warning')).toContainText('mcp.other.example')
  await expect(page.getByTestId('integrations-from-team').getByTestId('integration-row')).toHaveCount(0)
  // connecting again, to the address Bob has now seen, works
  await page.getByTestId('integration-answer-key').fill(KEY)
  await page.getByTestId('integration-answer-connect').click()
  await expect(page.getByTestId('integrations-from-team').getByTestId('integration-row').filter({ hasText: 'Tasks' })).toHaveCount(1)
  await admin.close()
})
