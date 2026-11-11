// The list-style Admin and Settings pages on a phone (docs/DECISIONS.md "Admin and Settings on phones", PR 2 of
// docs/AGENTS/plan/20261110-1336-phone-admin-list.md), at 390×844 in a real browser: no page is wider than the screen
// (also in Spanish), each page's main button is on the first screen, and its filters open from one Filters button.
// Then each page's own fix: Groups' compact rows, Folder permissions' switch under Filters beside By folder / By
// person, Providers' accounts on tap, Connectors' rows with a 44 px +, AI apps' 44 px targets, Plugins' one line per
// plugin, Slack's 44 px targets, Usage's range with Filters and Group by in the breakdown, Activity log's kinds under
// Filters, Settings › Providers named in the bar, Settings › Usage's period under its line. A computer keeps every page
// as it was.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' })

const t = DICTS.en
const box = async (l: Locator) => (await l.boundingBox())!
const middle = (b: { y: number; height: number }) => b.y + b.height / 2
/** two things on one row: their middles within 4 px */
const sameRow = async (a: Locator, b: Locator) => expect(Math.abs(middle(await box(a)) - middle(await box(b)))).toBeLessThanOrEqual(4)
const tall = async (l: Locator) => expect(Math.round((await box(l)).height)).toBeGreaterThanOrEqual(44)

/** Nothing scrolls sideways: the document, Admin's scrolling area and the Settings section. */
async function fits(page: Page) {
  const over = await page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll<HTMLElement>('[data-testid="admin-content"], [data-testid="settings-content"]')].map((e) => e.scrollWidth - e.clientWidth),
  )
  for (const d of over) expect(d).toBeLessThanOrEqual(0)
}

/** each page: what shows once it has loaded, its main button, and its Filters button (`filters`: its test id prefix) */
const PAGES: { path: string; ready: string; primary?: string; filters?: string }[] = [
  { path: '/admin/groups', ready: 'group-list', primary: 'group-new' },
  { path: '/admin/folders', ready: 'access-tree', primary: 'folder-rule-new', filters: 'tree-filters' },
  { path: '/admin/providers', ready: 'engine-list' },
  { path: '/admin/connectors', ready: 'connector-list', primary: 'integration-add' },
  { path: '/admin/ai-apps', ready: 'admin-ai-app-list' },
  { path: '/admin/plugins', ready: 'plugins-catalog' },
  { path: '/admin/slack', ready: 'slack-status', primary: 'slack-toggle' },
  { path: '/admin/usage', ready: 'usage-stats', primary: 'usage-limits-link', filters: 'usage-filters' },
  { path: '/admin/audit', ready: 'audit-list', filters: 'activity-more' },
  { path: '/settings/providers', ready: 'my-providers' },
  // Settings › Connectors leads to the Connectors page (/connectors) since #366: its own design, not a Settings list
  { path: '/settings/ai-apps', ready: 'ai-app-list' },
  { path: '/settings/usage', ready: 'my-usage-totals' },
]

for (const locale of ['en', 'es'] as const) {
  test(`every list page fits the screen, its main button is on the first screen and its filters open (${locale})`, async ({ page }) => {
    test.setTimeout(120_000)
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    for (const p of PAGES) {
      await page.goto(p.path)
      await expect(page.getByTestId(p.ready)).toBeVisible()
      await fits(page)
      if (p.primary) await expect(page.getByTestId(p.primary)).toBeInViewport()
      if (p.filters) {
        const toggle = page.getByTestId(`${p.filters}-toggle`)
        await expect(toggle).toBeInViewport()
        await expect(page.getByTestId(p.filters)).toBeHidden()
        await toggle.click()
        await expect(page.getByTestId(p.filters)).toBeVisible()
        // open, the filters still fit (Activity log's kinds took about 550 px in Spanish)
        await fits(page)
      }
    }
  })
}

test.describe('each page', () => {
  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
  })

  test('Groups: one line per group, its member count on the right, the description under it', async ({ page }) => {
    await page.goto('/admin/groups')
    const row = page.getByTestId('group-row').first()
    await expect(row).toBeVisible()
    // the count on the right of the name, inside the row (centred on its two lines)
    const name = await box(row.getByText('재무팀', { exact: true }))
    const count = await box(row.getByTestId('group-member-count'))
    expect(count.x).toBeGreaterThan(name.x + name.width)
    expect(count.y).toBeLessThan(name.y + name.height)
    await expect(row.getByTestId('group-member-count')).toHaveText('1 member')
    await expect(row).toContainText('재무 자료')
    expect((await box(row)).height).toBeLessThanOrEqual(64)
    // the faces and the names are the group dialog's now
    await expect(row.getByText('Olga')).toHaveCount(0)
  })

  test('Folder permissions: By folder / By person and Filters on one row; the switch is under Filters', async ({ page }) => {
    await page.goto('/admin/folders')
    const views = page.getByRole('tablist', { name: t['accessView.tabs'] })
    await sameRow(views, page.getByTestId('tree-filters-toggle'))
    await expect(page.getByTestId('tree-ruled-only')).toBeHidden()
    await page.getByTestId('tree-filters-toggle').click()
    await page.getByTestId('tree-filters').getByText(t['accessTree.ruledOnly']).click()
    await expect(page.getByTestId('tree-ruled-only')).toBeChecked()
    await expect(page.getByTestId('tree-filters-count')).toContainText('1')
    // the views still switch, with no history added (PR 1a)
    await views.getByRole('tab', { name: t['accessView.byPerson'] }).click()
    await expect(page.getByTestId('access-person-search')).toBeVisible()
  })

  test('Providers: one row per engine; its accounts and Add account open when its name is tapped', async ({ page }) => {
    await page.goto('/admin/providers')
    const claude = page.locator('[data-testid="engine-card"][data-engine="claude-code"]')
    await expect(claude).toBeVisible()
    await expect(page.getByTestId('provider-accounts-claude')).toHaveCount(0)
    // the dim line (how it signs in, models, when checked) is in the opened part; the name is a 44 px target
    await expect(claude.getByText(t['engines.mode.local-login'].replace('{provider}', ''), { exact: false })).toHaveCount(0)
    await tall(claude.getByTestId('engine-open'))
    await claude.getByTestId('engine-open').click()
    await expect(page.getByTestId('provider-accounts-claude')).toBeVisible()
    await expect(page.getByTestId('provider-add-claude')).toBeVisible()
  })

  test('Providers: an account that needs a look stays in sight under a closed row', async ({ page }) => {
    // the team's one Claude account needs signing in again (the mock has none, so the list is answered here)
    await page.route('**/api/admin/credentials', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      const at = new Date().toISOString()
      body.items = [{
        id: '01900000-0000-7000-8000-00000000c1a1', kind: 'anthropic-oauth', label: 'Acme Claude', scope: 'team', owner: null, assignments: [], priority: 10,
        disabled: false, state: 'needs_reconnect', detail: null, hint: null, planType: null, expiresAt: null, limitedUntil: null, checkedAt: at,
        lastUsedAt: null, spendLimit: { usd: null, tokens: null, action: 'block' }, month: { usd: 0, tokens: 0, requests: 0 }, createdAt: at,
      }]
      await route.fulfill({ response: res, json: body })
    })
    await page.goto('/admin/providers')
    await expect(page.getByTestId('provider-accounts-claude').getByTestId('credential-row')).toBeVisible()
    await expect(page.getByTestId('provider-accounts-codex')).toHaveCount(0)
  })

  test('Connectors: Discover is rows without frames, with a 44 px +', async ({ page }) => {
    // Admin's (Settings › Connectors leads to the Connectors page since #366)
    for (const path of ['/admin/connectors']) {
      await page.goto(path)
      const card = page.locator('[data-testid="connector-card"][data-id="notion"]')
      await expect(card).toBeVisible()
      expect((await box(card)).height).toBeLessThanOrEqual(60)
      expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      await tall(card.getByTestId('connector-add'))
      await expect(card.getByText(t['connectors.by'].replace('{maker}', 'Notion'))).toBeHidden()
    }
  })

  test('AI apps: Copy and Connect are 44 px tall, in Admin and in Settings', async ({ page }) => {
    for (const path of ['/admin/ai-apps', '/settings/ai-apps']) {
      await page.goto(path)
      await tall(page.getByTestId('connector-address-copy'))
      await tall(page.getByTestId('ai-app-connect-claude'))
    }
  })

  test('Plugins: no frames, one line per plugin with Install; what it does opens on its name', async ({ page }) => {
    await page.goto('/admin/plugins')
    const row = page.getByTestId('plugin-catalog').first()
    await expect(row.getByTestId('plugin-catalog-install')).toBeVisible()
    await sameRow(row.getByTestId('plugin-open'), row.getByTestId('plugin-catalog-install'))
    expect((await box(row)).height).toBeLessThanOrEqual(64)
    await expect(row.getByTestId('plugin-permissions')).toHaveCount(0)
    await row.getByTestId('plugin-open').click()
    await expect(row.getByTestId('plugin-open')).toHaveAttribute('aria-expanded', 'true')
    await expect(row.getByTestId('plugin-permissions')).toBeVisible()
    // the sections are not framed
    const section = page.getByTestId('plugins-catalog').locator('xpath=ancestor::section[1]')
    expect(await section.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('0px')
    await expect(page.getByTestId('plugins-installed-empty')).toHaveText(t['plugins.installedEmpty'])
  })

  test('Plugins: an installed plugin is one line with its state and Turn off; Remove opens with the rest', async ({ page }) => {
    await page.goto('/admin/plugins')
    const starter = page.locator('[data-testid="plugin-catalog"][data-plugin="app.trina.office-starter"]')
    await starter.getByTestId('plugin-catalog-install').click()
    await page.getByRole('dialog').getByTestId('plugin-install-enable').click()
    const row = page.locator('[data-testid="plugin-installed"][data-plugin="app.trina.office-starter"]')
    await expect(row.getByTestId('plugin-disable')).toBeVisible()
    await sameRow(row.getByTestId('plugin-open'), row.getByTestId('plugin-disable'))
    await tall(row.getByTestId('plugin-disable'))
    await expect(row).toContainText(t['plugins.status.enabled'])
    await expect(row.getByTestId('plugin-remove')).toHaveCount(0)
    await row.getByTestId('plugin-open').click()
    await expect(row.getByTestId('plugin-permissions')).toBeVisible()
    await expect(row.getByTestId('plugin-remove')).toBeVisible()
  })

  test('Slack: Turn off and Replace tokens are 44 px tall, without a frame', async ({ page }) => {
    await page.goto('/admin/slack')
    await tall(page.getByTestId('slack-toggle'))
    await tall(page.getByTestId('slack-replace'))
    const card = page.getByTestId('slack-status').locator('xpath=ancestor::section[1]')
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
  })

  test('Usage: the range and Filters on one row, Usage limits ⌄ Download CSV, Group by in the breakdown, no frames', async ({ page }) => {
    await page.goto('/admin/usage')
    await expect(page.getByTestId('usage-stats')).toBeVisible()
    await sameRow(page.getByTestId('usage-range-pill'), page.getByTestId('usage-filters-toggle'))
    await expect(page.getByTestId('usage-filter-user-pill')).toBeHidden()
    await page.getByTestId('usage-filters-toggle').click()
    await page.getByTestId('usage-filter-user').selectOption({ label: 'Bob' })
    await expect(page.getByTestId('usage-filters-count')).toContainText('1')
    await expect(page.getByTestId('usage-filters-clear')).toBeVisible()
    // Group by is a view choice: beside the breakdown's heading, not among the filters
    const breakdown = page.getByRole('region', { name: t['usage.breakdownTitle'] })
    await expect(breakdown.getByTestId('usage-groupby')).toBeVisible()
    await expect(page.getByTestId('usage-filters').getByTestId('usage-groupby')).toHaveCount(0)
    // the numbers stand without frames
    expect(await page.getByTestId('usage-stat-in').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    // one main button, 44 px like its ⌄; Download CSV under the ⌄
    await tall(page.getByTestId('usage-limits-link'))
    await tall(page.getByTestId('usage-limits-link-more'))
    await expect(page.getByTestId('usage-csv')).toHaveCount(0)
    await page.getByTestId('usage-limits-link-more').click()
    await expect(page.getByRole('menu', { name: t['common.moreActions'] }).getByRole('menuitem')).toHaveText([t['usage.exportCsv']])
    await page.keyboard.press('Escape')
    await page.getByTestId('usage-limits-link').click()
    // on a phone the limits are a group of Team settings of their own (teamSettingsGroups.ts, #342)
    await expect(page).toHaveURL(/\/admin\/settings\/limits#ai-limits$/)
  })

  test('Activity log: the search and Filters on one row, the only part that stays; the kinds open under Filters', async ({ page }) => {
    await page.goto('/admin/audit')
    await expect(page.getByTestId('audit-list')).toBeVisible()
    await sameRow(page.getByTestId('activity-search'), page.getByTestId('activity-more-toggle'))
    expect((await box(page.getByTestId('activity-header'))).height).toBeLessThanOrEqual(60)
    await expect(page.getByTestId('activity-kinds')).toBeHidden()
    await page.getByTestId('activity-more-toggle').click()
    await page.getByTestId('activity-kinds').getByRole('button', { name: t['activity.chip.auth'], exact: true }).click()
    await expect(page).toHaveURL(/[?&]kind=auth\b/)
    await expect(page.getByTestId('activity-more-count')).toContainText('1')
    await page.getByTestId('activity-clear').click()
    await expect(page).toHaveURL(/\/admin\/audit$/)
  })

  test('Settings › Providers: the bar names it, and the card has no frame', async ({ page }) => {
    await page.goto('/settings/providers')
    await expect(page.getByTestId('settings-section-title')).toHaveText(t['settings.providers'])
    const card = page.getByTestId('my-providers').locator('xpath=ancestor::section[1]')
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
  })

  test('Settings › Usage: the period under the line, Refresh 44 px, the numbers on one row', async ({ page }) => {
    await page.goto('/settings/usage')
    const desc = await box(page.getByTestId('my-usage-desc'))
    expect((await box(page.getByTestId('my-usage-period-pill'))).y).toBeGreaterThanOrEqual(desc.y + desc.height)
    await tall(page.getByTestId('my-usage-refresh'))
    const totals = page.getByTestId('my-usage-totals').locator('dd')
    // answers and the estimate (#347 took the tokens off a member's screen)
    await expect(totals).toHaveCount(2)
    await sameRow(totals.nth(0), totals.nth(1))
    // a nine-digit total still fits its part of the row on one line
    const one = (await box(totals.nth(0))).height
    await totals.nth(1).evaluate((el) => { el.textContent = '123,456,789' })
    expect((await box(totals.nth(1))).height).toBeLessThanOrEqual(one + 1)
  })
})

test.describe('a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
  test('the pages keep their rows, filters and frames', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/admin/usage')
    for (const id of ['usage-groupby', 'usage-filter-user', 'usage-csv', 'usage-limits-link']) await expect(page.getByTestId(id)).toBeVisible()
    await expect(page.getByTestId('usage-filters-toggle')).toHaveCount(0)
    expect(await page.getByTestId('usage-stat-in').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')
    await page.goto('/admin/audit')
    await expect(page.getByTestId('activity-kinds')).toBeVisible()
    await expect(page.getByTestId('activity-more-toggle')).toHaveCount(0)
    await page.goto('/admin/folders')
    await expect(page.getByTestId('tree-ruled-only')).toBeVisible()
    await page.goto('/admin/providers')
    await expect(page.getByTestId('provider-accounts-claude')).toBeVisible()
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugin-permissions').first()).toBeVisible()
    await expect(page.getByTestId('plugin-open')).toHaveCount(0)
    await page.goto('/admin/groups')
    await expect(page.getByTestId('group-row')).toHaveCount(0)
    await expect(page.getByTestId('group-list')).toContainText('Olga')
    await page.goto('/admin/slack')
    expect(await page.getByTestId('slack-status').locator('xpath=ancestor::section[1]').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')
    for (const path of ['/admin/connectors']) {
      await page.goto(path)
      const card = page.locator('[data-testid="connector-card"][data-id="notion"]')
      await expect(card.getByText(t['connectors.by'].replace('{maker}', 'Notion'))).toBeVisible()
      expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    }
    await page.goto('/settings/usage')
    await expect(page.getByRole('heading', { name: t['myUsage.title'] })).toBeVisible()
    await page.goto('/settings/providers')
    await expect(page.getByRole('heading', { name: t['settings.providers'], exact: true })).toBeVisible()
  })
})
