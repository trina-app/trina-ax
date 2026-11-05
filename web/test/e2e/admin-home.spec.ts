// Admin: Home first (what needs attention, then one card per area), a grouped menu that stays put while a page
// scrolls, and explanations kept to one line with "More" (pages/admin/AdminLayout.tsx, Home.tsx, common.tsx OneLine).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, type MessageKey } from '../../src/i18n'
import { turnWhen } from '../../src/lib/updateTurn'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

const MENU: [MessageKey, MessageKey[]][] = [
  ['admin.group.people', ['admin.members', 'admin.groups', 'admin.folders']],
  ['admin.group.shared', ['admin.engines', 'admin.credentials', 'admin.integrations', 'connectors.title', 'aiApps.title', 'admin.plugins']],
  ['admin.group.activity', ['admin.usage', 'admin.audit']],
  ['admin.group.settings', ['admin.settings', 'admin.system']],
]

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

/** the after-update to-do for the HWP plugin is on until the plugin is on or it is dismissed; tests about other items dismiss it */
const dismissHwp = async (page: Page) => expect((await page.request.post('/api/admin/after-update/hwp-plugin/dismiss', { headers: { [CSRF_HEADER]: '1' }, data: {} })).status()).toBe(204)

test('admin opens on Home: problems first, then one card per area, each opening its page', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page)
  await dismissHwp(page)
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
  await dismissHwp(page)
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

const NEW_STATUS = { current: '0.2.0', channel: 'stable', available: { version: '0.3.0', notes: '', publishedAt: new Date().toISOString(), needsBackupRestoreToRollBack: false }, lastCheckedAt: new Date().toISOString(), previous: null, feed: true, needsRoot: false, auto: false, managed: false }
const answerUpdate = (page: Page, make: () => { status?: number; json: unknown }) => page.route('**/api/admin/update', (r) => (r.request().method() === 'GET' ? r.fulfill(make()) : r.fallback()))

test('a new version is an attention item for the owner; a failed update status is no item and Home still shows', async ({ page }) => {
  await start(page)
  await answerUpdate(page, () => ({ json: NEW_STATUS }))
  await page.goto('/admin')
  const row = page.getByTestId('attention-update')
  await expect(row.getByRole('link', { name: t['adminHome.update.off'].replace('{version}', '0.3.0') })).toHaveAttribute('href', '/admin/system')

  // managed (hosted) installs are updated by the provider: no item
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...NEW_STATUS, managed: true } }))
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('attention-update')).toHaveCount(0)

  // office mode (the office status is not null) has its own banner: no item here
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: NEW_STATUS }))
  const officeStatus = { version: '0.2.0', channel: 'stable', paused: false, time: '03:00', nextWindowAt: null, lastCheckAt: null, last: null, available: null, lastUpdate: null, running: null, requested: false, agentInstalled: true, desktop: null }
  await page.route('**/api/admin/office-update', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: officeStatus }) : r.fallback()))
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('attention-update')).toHaveCount(0)
  await page.unroute('**/api/admin/office-update')

  // a failing status: no item, nothing else breaks
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ status: 500, json: { error: { code: 'internal', message: 'boom' } } }))
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-engines')).toContainText('Default: Claude Code')
  await expect(page.getByTestId('attention-update')).toHaveCount(0)
})

test('automatic updates on: the item says when it installs, with no button; a release that needs root says the timer does it', async ({ page }) => {
  await start(page)
  const at = new Date(Date.now() + 3600_000).toISOString()
  const auto = { ...NEW_STATUS, auto: true, window: '03:00-05:00', timeZone: 'Asia/Seoul', nextWindow: { at, day: 'tomorrow' } }
  await answerUpdate(page, () => ({ json: auto }))
  await page.goto('/admin')
  const row = page.getByTestId('attention-update')
  await expect(row).toContainText(t['adminHome.update.auto'].replace('{version}', '0.3.0').replace('{when}', t['adminHome.when.tomorrow.dawn'].replace('{window}', '03:00–05:00')))
  await expect(row.getByRole('button')).toHaveCount(0)

  // inside the window now; an evening window; a window that never opens
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, nextWindow: { at, day: 'now' } } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.when.now'])
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, window: '22:00-01:00', nextWindow: { at, day: 'today' } } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.when.today.night'].replace('{window}', '22:00–01:00'))
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, nextWindow: null } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.off'].replace('{version}', '0.3.0'))
  await expect(page.getByTestId('attention-update').getByRole('button', { name: t['adminHome.update.install'] })).toBeVisible()

  // not this server's turn / on hold: says so and still offers the manual install; a window that never opens counts as off
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, hold: 'rollout' } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rollout'].replace('{version}', '0.3.0'))
  await expect(page.getByTestId('attention-update').getByRole('button', { name: t['adminHome.update.install'] })).toBeVisible()
  // the server says when this server's turn comes (turnAt): the window that turn falls in, in the same day words, or its
  // date when it is further away; Install now still takes it at once
  for (const days of [1, 3]) {
    const turnAt = new Date(Date.now() + days * 86_400_000).toISOString()
    await page.unroute('**/api/admin/update')
    await answerUpdate(page, () => ({ json: { ...auto, hold: 'rollout', turnAt } }))
    await page.goto('/admin')
    const w = turnWhen(turnAt, '03:00-05:00', 'Asia/Seoul')!
    const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(w.date)
    const when = t[`adminHome.when.${w.day}.dawn` as MessageKey].replace('{window}', '03:00–05:00').replace('{date}', date)
    if (days === 3) expect(w.day).toBe('date')
    await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rolloutAt'].replace('{version}', '0.3.0').replace('{when}', when))
    await expect(page.getByTestId('attention-update').getByRole('button', { name: t['adminHome.update.install'] })).toBeVisible()
  }
  // a release this server's roll-out never reaches by itself (turnAt null): says so, and Install now does it
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, hold: 'rollout', turnAt: null } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rolloutNever'].replace('{version}', '0.3.0'))
  await expect(page.getByTestId('attention-update').getByRole('button', { name: t['adminHome.update.install'] })).toBeVisible()
  // a release that needs root waits for this server's turn too: the update timer installs it then; never by itself: the command
  {
    const turnAt = new Date(Date.now() + 3 * 86_400_000).toISOString()
    await page.unroute('**/api/admin/update')
    await answerUpdate(page, () => ({ json: { ...auto, needsRoot: true, turnAt } }))
    await page.goto('/admin')
    const w = turnWhen(turnAt, '03:00-05:00', 'Asia/Seoul')!
    const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(w.date)
    const when = t[`adminHome.when.${w.day}.dawn` as MessageKey].replace('{window}', '03:00–05:00').replace('{date}', date)
    await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rootAt'].replace('{version}', '0.3.0').replace('{when}', when))
    await expect(page.getByTestId('attention-update').getByRole('button')).toHaveCount(0)
    await page.unroute('**/api/admin/update')
    await answerUpdate(page, () => ({ json: { ...auto, needsRoot: true, turnAt: null } }))
    await page.goto('/admin')
    await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rootManual'].replace('{version}', '0.3.0'))
  }
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, hold: 'failed' } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.failed'].replace('{version}', '0.3.0'))
  await expect(page.getByTestId('attention-update').getByRole('button', { name: t['adminHome.update.install'] })).toBeVisible()

  // needs root: the update timer installs it; no button
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, needsRoot: true } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.root'].replace('{version}', '0.3.0'))
  await expect(page.getByTestId('attention-update').getByRole('button')).toHaveCount(0)
  // root's update failed: say so, no timer promise; automatic updates off: run the command
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...auto, needsRoot: true, hold: 'root_failed' } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rootFailed'].replace('{version}', '0.3.0'))
  await expect(page.getByTestId('attention-update')).toHaveAttribute('href', '/admin/system')
  await page.unroute('**/api/admin/update')
  await answerUpdate(page, () => ({ json: { ...NEW_STATUS, needsRoot: true } }))
  await page.goto('/admin')
  await expect(page.getByTestId('attention-update')).toContainText(t['adminHome.update.rootManual'].replace('{version}', '0.3.0'))
})

test('automatic updates off: the item has an install button that asks what Admin > System asks', async ({ page }) => {
  await start(page)
  await answerUpdate(page, () => ({ json: NEW_STATUS }))
  await page.goto('/admin')
  const row = page.getByTestId('attention-update')
  await expect(row).toContainText(t['adminHome.update.off'].replace('{version}', '0.3.0'))
  await row.getByRole('button', { name: t['adminHome.update.install'] }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: t['system.installUpdate'] })).toBeVisible()
  await expect(dialog).toContainText(t['system.updateNote'])
  await dialog.getByRole('button', { name: t['common.cancel'] }).click()

  // Admin > System opens the very same dialog
  await page.goto('/admin/system')
  await page.getByRole('button', { name: t['system.installUpdate'] }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: t['system.installUpdate'] })).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText(t['system.updateNote'])
})

test('the HWP plugin to-do shows with a button to the plugin, and "not needed" keeps it away after a reload', async ({ page }) => {
  await start(page)
  await page.goto('/admin')
  const row = page.getByTestId('attention-after-hwp-plugin')
  await expect(row).toContainText(t['adminHome.after.hwp-plugin'])
  await row.getByRole('button', { name: t['adminHome.after.hwp-plugin.go'] }).click()
  await expect(page).toHaveURL(/\/admin\/plugins\?focus=app\.trina\.hwp-preview$/)
  await expect(page.locator('[data-plugin="app.trina.hwp-preview"]').first()).toBeFocused()

  await page.goto('/admin')
  await page.getByTestId('attention-after-hwp-plugin').getByRole('button', { name: t['adminHome.after.dismiss.label'].replace('{todo}', t['adminHome.after.hwp-plugin']) }).click()
  await expect(page.getByTestId('attention-after-hwp-plugin')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('attention-after-hwp-plugin')).toHaveCount(0)
})

// Y — Home shows one thing at a time: the owner's setup checklist moved here from the chat Home, finished steps hidden
test('the owner\'s setup steps still to do are on Admin Home (not on Home); hidden once dismissed; admins never see them', async ({ page }) => {
  await start(page)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('owner-checklist')).toHaveCount(0)
  await page.goto('/admin')
  const list = page.getByTestId('owner-checklist')
  await expect(list.getByRole('heading', { name: t['owner.check.title'] })).toBeVisible()
  // the mock's Claude Code works and the team has members: those steps are done, so they are not listed
  await expect(list.getByRole('link')).not.toHaveCount(0)
  await expect(list.getByText(t['owner.check.engine'])).toHaveCount(0)
  await expect(list.getByText(t['owner.check.members'])).toHaveCount(0)
  for (const link of await list.getByRole('link').all()) await expect(link).toHaveAccessibleName(new RegExp(`^${t['common.todo']} `))
  await list.getByTestId('owner-checklist-hide').click()
  await expect(list).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('owner-checklist')).toHaveCount(0)
  // an admin who is not the owner
  expect((await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' } })).ok()).toBe(true)
  await page.evaluate(() => localStorage.clear())
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('owner-checklist')).toHaveCount(0)
})

test('an admin who is not the owner does not ask for the update status', async ({ page }) => {
  await start(page)
  expect((await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' } })).ok()).toBe(true)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  const asked: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/admin/update') asked.push(r.method()) })
  await page.goto('/admin')
  await expect(page.getByTestId('admin-home-members')).toBeVisible()
  await expect(page.getByTestId('admin-home-system')).toBeVisible()
  expect(asked).toEqual([])
})
