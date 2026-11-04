// Admin: Home first (what needs attention, then one card per area), a grouped menu that stays put while a page
// scrolls, and explanations kept to one line with "More" (pages/admin/AdminLayout.tsx, Home.tsx, common.tsx OneLine).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, type MessageKey } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

const MENU: [MessageKey, MessageKey[]][] = [
  ['admin.group.people', ['admin.members', 'admin.groups', 'admin.folders']],
  ['admin.group.shared', ['admin.engines', 'admin.credentials', 'admin.integrations', 'admin.plugins']],
  ['admin.group.activity', ['admin.usage', 'admin.audit']],
  ['admin.group.settings', ['admin.settings', 'admin.system']],
]

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

test('admin opens on Home: problems first, then one card per area, each opening its page', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page)
  // a team service still waiting for its sign-in
  const made = await page.request.post('/api/admin/integrations', { headers: { [CSRF_HEADER]: '1' }, data: { kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', access: { everyone: true, groups: [], users: [] } } })
  expect(made.status()).toBe(201)
  await page.getByRole('link', { name: t['sidebar.admin'], exact: true }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { level: 1, name: t['admin.title'] })).toBeVisible()

  // the menu: Home first, then the groups, what the team shares in a group of its own
  const menu = page.getByRole('navigation', { name: t['admin.title'] })
  await expect(menu.getByRole('link').first()).toHaveText(t['admin.home'])
  await expect(menu.getByRole('link', { name: t['admin.home'], exact: true })).toHaveAttribute('aria-current', 'page')
  for (const [group, items] of MENU) {
    const g = menu.getByRole('group', { name: t[group] })
    await expect(g.getByRole('link')).toHaveText(items.map((k) => t[k]))
    await expect(g.getByText(t[group], { exact: true })).toBeVisible()
  }

  // what needs attention, in a few words each: the engine that is on but signed out, the service, the disk (82% in the mock)
  const attention = page.getByTestId('admin-attention')
  await expect(attention.getByRole('link')).toHaveText([`Codex: ${t['engines.status.not_logged_in']}`, `Notion: ${t['integrations.status.needs_auth']}`, 'Storage 82% used'])
  await expect(attention.getByRole('link', { name: /^Codex/ })).toHaveAttribute('href', '/admin/engines')
  await expect(attention.getByRole('link', { name: /^Notion/ })).toHaveAttribute('href', '/admin/integrations')

  // the areas: each card says its state in a line and opens its page
  await expect(page.getByTestId('admin-home-members')).toContainText(/\d+ members/)
  await expect(page.getByTestId('admin-home-engines')).toContainText('Default: Claude Code')
  await expect(page.getByTestId('admin-home-engines')).toContainText('1 to fix')
  await expect(page.getByTestId('admin-home-integrations')).toContainText('1 connection')
  await expect(page.getByTestId('admin-home-plugins')).toContainText(/\d+ plugins? installed/)
  await expect(page.getByTestId('admin-home-usage')).toContainText(t['adminHome.last30'])
  await expect(page.getByTestId('admin-home-audit')).not.toContainText(t['adminHome.unavailable'])
  await expect(page.getByTestId('admin-home-system')).toContainText('Storage 82% used')
  await expect(page.getByText(t['admin.privacy'])).toBeVisible()
  await page.getByTestId('admin-home-engines').click()
  await expect(page).toHaveURL(/\/admin\/engines$/)
  await expect(menu.getByRole('link', { name: t['admin.engines'], exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('engine-card').first()).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('nothing to fix: Home says so in one line; an unknown admin page goes to Home', async ({ page }) => {
  await start(page)
  await page.route('**/api/admin/engines', async (r) => {
    const res = await r.fetch()
    const body = await res.json()
    await r.fulfill({ response: res, json: { ...body, engines: body.engines.map((e: { status: string }) => ({ ...e, status: 'ok', detail: null })) } })
  })
  await page.route('**/api/admin/storage', async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, json: { ...(await res.json()), percent: 40, level: 'ok' } })
  })
  await page.route('**/api/admin/diagnostics', async (r) => {
    const res = await r.fetch()
    const body = await res.json()
    await r.fulfill({ response: res, json: { ...body, checks: body.checks.map((c: object) => ({ ...c, status: 'ok' })) } })
  })
  await page.goto('/admin/nothing-here')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-all-good')).toHaveText(t['adminHome.allGood'])
  await expect(page.getByTestId('admin-attention')).toHaveCount(0)
  await expect(page.getByTestId('admin-home-system')).toContainText(t['adminHome.checksOk'])
})

test('people who cannot use AI are named first, and the AI connections card counts them', async ({ page }) => {
  await start(page)
  await page.route('**/api/admin/users?noAi=1', async (r) => {
    const res = await r.fetch()
    const body = await res.json()
    await r.fulfill({ response: res, json: { ...body, noAi: body.items.filter((u: { username: string }) => u.username === 'bob').map((u: { id: string }) => u.id) } })
  })
  await page.goto('/admin')
  const row = page.getByTestId('admin-attention').getByRole('link', { name: "1 person can't use AI: Bob" })
  await expect(row).toHaveAttribute('href', '/admin/credentials')
  await expect(page.getByTestId('admin-home-credentials')).toContainText('1 to fix')
})

test('an area that cannot be read says so on its card; the others still show', async ({ page }) => {
  await start(page)
  await page.route('**/api/admin/usage**', (r) => r.fulfill({ status: 500, json: { error: { code: 'internal', message: 'boom' } } }))
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-usage')).toContainText(t['adminHome.unavailable'])
  await expect(page.getByTestId('admin-home-engines')).toContainText('Default: Claude Code')
})

test('the admin menu stays where it is while the page scrolls, on a wide screen and on a phone', async ({ page }) => {
  await start(page)
  for (const size of [{ width: 1360, height: 640 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(size)
    // Team provider settings: the longer of the two AI engines tabs
    await page.goto('/admin/engines?tab=team')
    await expect(page.getByTestId('engine-choice')).toBeVisible()
    const menu = page.getByTestId('admin-menu')
    const before = (await menu.boundingBox())!
    const content = page.getByTestId('admin-content')
    expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await content.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    expect((await menu.boundingBox())!.y).toBe(before.y)
    await expect(menu.getByRole('link', { name: t['admin.engines'], exact: true })).toBeInViewport()
    await expect(menu.getByRole('link', { name: t['admin.home'], exact: true })).toBeAttached()
  }
})

test('a long explanation stays on one line until "More" opens it', async ({ page }) => {
  await start(page)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto('/admin/engines?tab=team')
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: t['engines.choice'], exact: true }) })
  const desc = card.getByText(t['engines.choiceDesc'], { exact: true })
  await expect(desc).toBeVisible()
  const oneLine = await desc.evaluate((el) => el.getBoundingClientRect().height)
  const more = card.getByRole('button', { name: t['common.more'], exact: true }).first()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(card.getByRole('button', { name: t['common.less'], exact: true }).first()).toHaveAttribute('aria-expanded', 'true')
  expect(await desc.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(oneLine * 1.5)
})

test('a new version is an attention item for the owner; a failed update status is no item and Home still shows', async ({ page }) => {
  await start(page)
  const status = { current: '0.2.0', channel: 'stable', available: { version: '0.3.0', notes: '', needsBackupRestoreToRollBack: false }, lastCheckedAt: new Date().toISOString(), previous: null, feed: true, needsRoot: false, auto: false, managed: false }
  const answer = (make: () => { status?: number; json: unknown }) => page.route('**/api/admin/update', (r) => (r.request().method() === 'GET' ? r.fulfill(make()) : r.fallback()))
  await answer(() => ({ json: status }))
  await page.goto('/admin')
  const row = page.getByTestId('admin-attention').getByRole('link', { name: t['adminHome.newVersion'].replace('{version}', '0.3.0') })
  await expect(row).toHaveAttribute('href', '/admin/system')

  // managed (hosted) installs are updated by the provider: no item
  await page.unroute('**/api/admin/update')
  await answer(() => ({ json: { ...status, managed: true } }))
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('admin-attention').getByRole('link', { name: /0\.3\.0/ })).toHaveCount(0)

  // a failing status: no item, nothing else breaks
  await page.unroute('**/api/admin/update')
  await answer(() => ({ status: 500, json: { error: { code: 'internal', message: 'boom' } } }))
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-engines')).toContainText('Default: Claude Code')
  await expect(page.getByTestId('admin-attention').getByRole('link', { name: /0\.3\.0/ })).toHaveCount(0)
})
