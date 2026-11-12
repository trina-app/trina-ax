// Admin's pages on a phone (390×844, touch), the QA rows' steps as they say them:
// - TC-377: Admin › Members & invites, Groups, Folder permissions, Usage, Team settings › Usage limits and Company
//   profile → "The page's main action is the bar's + (or ⋯ for a second one); no 'Invite to team ⌄' / 'New group' /
//   'Add folder' / 'Usage limits ⌄' / 'Add limit' / 'Create' button block at the top of the content." The split
//   buttons' other choices are the bar's ⋯ sheet; every bar button is 44 px with a name.
// - TC-379: Members & invites, Groups, Folder permissions, Activity log, Usage → "One full-width search field; Filters
//   is an icon (with a count when set) in the field or the bar and opens the sheet; 'By folder / By person' fits on its
//   own line; nothing wraps or crowds."
// - TC-382 item 3: Members' rows say the role in words (no select); it is changed on the person's page.
// A computer keeps every page as it was. Each test runs in WebKit (the iPhone app's engine:
// phone-admin-bar.webkit.spec.ts) and Chromium (Android's: phone-admin-bar.spec.ts).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.en
const W = 390
const box = async (l: Locator) => (await l.boundingBox())!
const middle = (b: { y: number; height: number }) => b.y + b.height / 2

/** 나 › Admin › a page, as a person taps it */
async function openAdmin(page: Page, id: string, url: RegExp) {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-admin').click()
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  await page.getByTestId(`admin-row-${id}`).click()
  await expect(page).toHaveURL(url)
}

/** Team settings › a group (Usage limits, Company profile) */
async function openTeamSettings(page: Page, group: string) {
  await openAdmin(page, 'settings', /\/admin\/settings$/)
  await page.getByTestId(`team-settings-row-${group}`).click()
  await expect(page).toHaveURL(new RegExp(`/admin/settings/${group}`))
}

const bar = (page: Page) => page.getByTestId('phone-page-bar')
const content = (page: Page) => page.getByTestId('admin-content')

/** the bar's buttons: on the bar's right, each 44 × 44 px with the name given */
async function barButtons(page: Page, names: string[]) {
  const buttons = bar(page).getByTestId('admin-bar-actions').getByRole('button')
  await expect(buttons).toHaveCount(names.length)
  for (const [i, name] of names.entries()) {
    const b = buttons.nth(i)
    await expect(b).toHaveAccessibleName(name)
    const r = await box(b)
    expect(Math.round(r.width), name).toBeGreaterThanOrEqual(44)
    expect(Math.round(r.height), name).toBeGreaterThanOrEqual(44)
    expect(r.x + r.width).toBeLessThanOrEqual(W)
    expect(r.x).toBeGreaterThan(W / 2)
  }
  // the page's name stays in the middle of the bar, whole
  const title = page.getByTestId('admin-bar-title')
  const tb = await box(title)
  expect(Math.abs(tb.x + tb.width / 2 - W / 2)).toBeLessThanOrEqual(2)
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
}

/** no button of these names in the page under the bar */
async function noBlock(page: Page, names: string[]) {
  for (const name of names) await expect(content(page).getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(content(page).getByRole('link', { name: t['adminux.usageLimitsLink'], exact: true })).toHaveCount(0)
}

/** nothing wider than the screen */
async function fits(page: Page) {
  const over = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll<HTMLElement>('[data-testid="admin-content"]')].map((e) => e.scrollWidth - e.clientWidth))
  for (const d of over) expect(d).toBeLessThanOrEqual(0)
}

/** a field across the content's width (16 px on each side) */
async function fullWidth(l: Locator) {
  const r = await box(l)
  expect(Math.round(r.x)).toBeLessThanOrEqual(17)
  expect(Math.round(r.x + r.width)).toBeGreaterThanOrEqual(W - 17)
}

/** `inner` inside `outer` */
async function inside(inner: Locator, outer: Locator) {
  const a = await box(inner), b = await box(outer)
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1)
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1)
  expect(a.y).toBeGreaterThanOrEqual(b.y - 1)
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1)
}

/** The Filters icon: 44 px, the word only for screen readers; it opens the sheet; a filter set shows its count */
async function filtersIcon(page: Page, prefix: string, choose: (sheet: Locator) => Promise<void>) {
  const toggle = page.getByTestId(`${prefix}-toggle`)
  await expect(toggle).toHaveAccessibleName(t['activity.filters'])
  await expect(toggle).not.toContainText(t['activity.filters'], { useInnerText: true })
  const r = await box(toggle)
  expect(Math.round(r.width)).toBeGreaterThanOrEqual(44)
  expect(Math.round(r.width)).toBeLessThanOrEqual(46)
  expect(Math.round(r.height)).toBeGreaterThanOrEqual(44)
  await expect(page.getByTestId(`${prefix}-count`)).toHaveCount(0)
  await toggle.click()
  const sheet = page.getByRole('dialog', { name: t['activity.filters'] })
  await expect(sheet).toBeVisible()
  await choose(sheet)
  await sheet.getByTestId(`${prefix}-done`).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByTestId(`${prefix}-count`)).toContainText('1')
  await expect(toggle).toHaveAccessibleName(`${t['activity.filters']} 1 on`)
}

export function adminBarCases() {
  // the app's service worker (WebKit) would answer the API itself, past page.route
  test.use({ viewport: { width: W, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
  })

  test('TC-377 Members & invites: + invites, ⋯ holds Add directly and the team invite link; no button block', async ({ page }) => {
    await openAdmin(page, 'members', /\/admin\/members$/)
    await expect(page.getByTestId('member-card-bob')).toBeVisible()
    await barButtons(page, [t['members.inviteMore'], t['members.inviteToTeam']])
    await noBlock(page, [t['members.inviteToTeam'], t['members.inviteMore']])
    await expect(page.getByTestId('members-header-actions')).toHaveCount(0)
    // +: the invite
    await bar(page).getByTestId('invite-new').click()
    await expect(page.getByRole('dialog', { name: t['members.invite'] })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // ⋯: the split button's other ways, as a bottom sheet
    await bar(page).getByTestId('invite-new-more').click()
    const sheet = page.getByRole('menu', { name: t['members.inviteMore'] })
    await expect(sheet.getByRole('menuitem')).toHaveText([t['members.add'], t['teamLink.title']])
    expect(Math.round((await box(sheet)).x)).toBe(0)
    for (const it of await sheet.getByRole('menuitem').all()) expect(Math.round((await box(it)).height)).toBeGreaterThanOrEqual(44)
    await sheet.getByTestId('member-add').click()
    await expect(page.getByRole('dialog', { name: t['members.add'] })).toBeVisible()
    await page.keyboard.press('Escape')
    await bar(page).getByTestId('invite-new-more').click()
    await page.getByRole('menu').getByTestId('team-link-open').click()
    await expect(page.getByRole('dialog', { name: t['teamLink.title'] })).toBeVisible()
    await page.keyboard.press('Escape')
    // a person's own page has no + of the list
    await page.getByTestId('member-card-bob').getByTestId('row-open').click()
    await expect(page.getByTestId('member-page')).toBeVisible()
    await expect(bar(page).getByTestId('admin-bar-actions')).toHaveCount(0)
  })

  test('TC-377 Groups: + makes a new group; no button block', async ({ page }) => {
    await openAdmin(page, 'groups', /\/admin\/groups$/)
    await expect(page.getByTestId('group-list')).toBeVisible()
    await barButtons(page, [t['groups.new']])
    await noBlock(page, [t['groups.new']])
    await bar(page).getByTestId('group-new').click()
    await expect(page.getByRole('dialog', { name: t['groups.new'] })).toBeVisible()
  })

  test('TC-377 Folder permissions: + adds a folder (By folder); no button block', async ({ page }) => {
    await openAdmin(page, 'folders', /\/admin\/folders$/)
    await expect(page.getByTestId('access-tree')).toBeVisible()
    // Filters (TC-379) and +
    await barButtons(page, [t['activity.filters'], t['rules.addFolder']])
    await noBlock(page, [t['rules.addFolder']])
    await bar(page).getByTestId('folder-rule-new').click()
    await expect(page.getByRole('dialog', { name: t['rules.addFolder'] })).toBeVisible()
  })

  test('TC-377 Usage: + opens Usage limits, ⋯ downloads the CSV; no button block', async ({ page }) => {
    await openAdmin(page, 'usage', /\/admin\/usage$/)
    await expect(page.getByTestId('usage-stats')).toBeVisible()
    await barButtons(page, [t['common.moreActions'], t['adminux.usageLimitsLink']])
    await noBlock(page, [t['adminux.usageLimitsLink'], t['common.moreActions'], t['usage.exportCsv']])
    await bar(page).getByTestId('usage-limits-link-more').click()
    const sheet = page.getByRole('menu', { name: t['common.moreActions'] })
    await expect(sheet.getByRole('menuitem')).toHaveText([t['usage.exportCsv']])
    const [download] = await Promise.all([page.waitForEvent('download'), sheet.getByTestId('usage-csv').click()])
    expect(download.suggestedFilename()).toMatch(/^usage-user-.*\.csv$/)
    await bar(page).getByTestId('usage-limits-link').click()
    await expect(page).toHaveURL(/\/admin\/settings\/limits#ai-limits$/)
  })

  test('TC-377 Team settings › Usage limits: + adds a limit; no button block', async ({ page }) => {
    await openTeamSettings(page, 'limits')
    await expect(page.getByTestId('engine-budgets')).toBeVisible()
    await barButtons(page, [t['budgets.new']])
    await noBlock(page, [t['budgets.new']])
    await bar(page).getByTestId('budget-new').click()
    await expect(page.getByRole('dialog', { name: t['budgets.new'] })).toBeVisible()
  })

  test('TC-377 Team settings › Company profile: + creates it, then Edit in the bar; no button block', async ({ page }) => {
    await openTeamSettings(page, 'company')
    await expect(content(page).getByText(t['onboarding.profile.none'])).toBeVisible()
    await barButtons(page, [t['onboarding.profile.createNamed']])
    await noBlock(page, [t['onboarding.profile.create'], t['onboarding.profile.edit']])
    await bar(page).getByTestId('company-profile-edit').click()
    await expect(page.getByRole('dialog', { name: t['onboarding.profile.title'] })).toBeVisible()
    await page.keyboard.press('Escape')
    // with a profile saved: "Edit" in the bar, still none in the page
    expect((await page.request.put('/api/onboarding/profile', { headers: { [CSRF_HEADER]: '1' }, data: { website: '', name: 'Acme', oneLine: 'We make tea.', products: '', audience: '', tone: [], avoid: '', sources: [] } })).ok()).toBeTruthy()
    await page.reload()
    await expect(content(page).getByText('We make tea.')).toBeVisible()
    await barButtons(page, [t['onboarding.profile.edit']])
    await noBlock(page, [t['onboarding.profile.create'], t['onboarding.profile.edit']])
  })

  test('TC-379 Members & invites: one full-width search with the Filters icon in it; its count when set', async ({ page }) => {
    await openAdmin(page, 'members', /\/admin\/members$/)
    await expect(page.getByTestId('member-card-bob')).toBeVisible()
    const field = page.getByTestId('member-search-field')
    await fullWidth(field)
    await inside(page.getByTestId('member-filters-toggle'), field)
    expect(Math.round((await box(field)).height)).toBeLessThanOrEqual(46)
    await fits(page)
    await filtersIcon(page, 'member-filters', (sheet) => sheet.getByTestId('member-role-filter').selectOption('owner').then(() => {}))
    await expect(page.getByTestId('member-card-olga')).toBeVisible()
    await expect(page.getByTestId('member-card-bob')).toHaveCount(0)
    // typing still searches
    await page.getByTestId('member-search').fill('olg')
    await expect(page.getByTestId('member-card-olga')).toBeVisible()
  })

  test('TC-379 Groups: the search alone, full width', async ({ page }) => {
    await openAdmin(page, 'groups', /\/admin\/groups$/)
    await expect(page.getByTestId('group-list')).toBeVisible()
    await fullWidth(page.getByTestId('group-search').locator('xpath=ancestor::label[1]'))
    await fits(page)
  })

  test('TC-379 Folder permissions: By folder / By person on a row of their own; Filters is an icon in the bar', async ({ page }) => {
    await openAdmin(page, 'folders', /\/admin\/folders$/)
    await expect(page.getByTestId('access-tree')).toBeVisible()
    const views = page.getByRole('tablist', { name: t['accessView.tabs'] })
    await fullWidth(views)
    // both words whole on one line
    for (const tab of await views.getByRole('tab').all()) {
      expect(await tab.evaluate((el) => { const s = el.querySelector('span')!; return s.scrollWidth <= s.clientWidth + 1 })).toBe(true)
      expect(Math.round((await box(tab)).height)).toBeLessThanOrEqual(48)
    }
    await inside(page.getByTestId('tree-filters-toggle'), bar(page))
    await fits(page)
    await filtersIcon(page, 'tree-filters', (sheet) => sheet.getByText(t['accessTree.ruledOnly']).click())
    await expect(page.getByTestId('tree-ruled-only')).toBeChecked()
    // By person: its search under the two views, full width; no Filters or + of By folder
    await views.getByRole('tab', { name: t['accessView.byPerson'] }).click()
    const search = page.getByTestId('access-person-search')
    await expect(search).toBeVisible()
    await fullWidth(search)
    expect((await box(search)).y).toBeGreaterThanOrEqual((await box(views)).y + (await box(views)).height)
    await expect(bar(page).getByTestId('tree-filters-toggle')).toHaveCount(0)
    await expect(bar(page).getByTestId('folder-rule-new')).toHaveCount(0)
  })

  test('TC-379 Activity log: one full-width search with the Filters icon in it; its count when set', async ({ page }) => {
    await openAdmin(page, 'audit', /\/admin\/audit$/)
    await expect(page.getByTestId('audit-list')).toBeVisible()
    const field = page.getByTestId('activity-search-field')
    await fullWidth(field)
    await inside(page.getByTestId('activity-more-toggle'), field)
    expect(Math.round((await box(page.getByTestId('activity-header'))).height)).toBeLessThanOrEqual(64)
    await fits(page)
    await filtersIcon(page, 'activity-more', (sheet) => sheet.getByTestId('activity-kinds').getByRole('button', { name: t['activity.chip.auth'], exact: true }).click())
    await expect(page).toHaveURL(/[?&]kind=auth\b/)
  })

  test('TC-379 Usage: the range across the row, the Filters icon at its end; nothing wraps', async ({ page }) => {
    await openAdmin(page, 'usage', /\/admin\/usage$/)
    await expect(page.getByTestId('usage-stats')).toBeVisible()
    const range = page.getByTestId('usage-range-pill')
    const toggle = page.getByTestId('usage-filters-toggle')
    expect(Math.abs(middle(await box(range)) - middle(await box(toggle)))).toBeLessThanOrEqual(2)
    expect(Math.round((await box(range)).x)).toBeLessThanOrEqual(17)
    expect(Math.round((await box(toggle)).x + (await box(toggle)).width)).toBeGreaterThanOrEqual(W - 17)
    expect(Math.round((await box(page.getByTestId('usage-controls'))).height)).toBeLessThanOrEqual(46)
    await fits(page)
    await filtersIcon(page, 'usage-filters', (sheet) => sheet.getByTestId('usage-filter-user').selectOption({ label: 'Bob' }).then(() => {}))
  })

  test('TC-382 item 3: Members\' rows say the role in words; the person\'s page changes it', async ({ page }) => {
    await openAdmin(page, 'members', /\/admin\/members$/)
    const bob = page.getByTestId('member-card-bob')
    await expect(bob).toBeVisible()
    await expect(bob.locator('select')).toHaveCount(0)
    await expect(bob.getByTestId('member-role-bob')).toHaveText(t['role.member'])
    // the row's name and its role on one line
    expect(Math.abs(middle(await box(bob.getByText('Bob', { exact: true }))) - middle(await box(bob.getByTestId('member-role-bob'))))).toBeLessThanOrEqual(4)
    // the row's ⋯ still has Edit (the dialog with the role)
    await bob.getByTestId('member-more').click()
    await expect(page.getByRole('menu').getByTestId('edit-member-bob')).toBeVisible()
    await page.keyboard.press('Escape')
    // the person's page: the role is a choice there
    await bob.getByTestId('row-open').click()
    const role = page.getByTestId('member-page').getByTestId('member-role-bob')
    await expect(role).toHaveJSProperty('tagName', 'SELECT')
    expect(Math.round((await box(role)).height)).toBeGreaterThanOrEqual(44)
    await role.selectOption('admin')
    await expect(page.getByText(t['members.roleChanged'].replace('{name}', 'Bob').replace('{role}', t['role.admin']))).toBeVisible()
    await page.getByTestId('admin-back').click()
    await expect(page).toHaveURL(/\/admin\/members$/)
    await expect(page.getByTestId('member-card-bob').getByTestId('member-role-bob')).toHaveText(t['role.admin'])
  })
}

/** A computer (1440 px): every page keeps its buttons and filters in the page; nothing goes to a bar. */
export function adminBarComputerCases() {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false, locale: 'en-US', serviceWorkers: 'block' })

  test('a computer keeps the buttons, the role choice and the filters in the page', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/admin/members')
    await expect(page.getByTestId('members-table')).toBeVisible()
    for (const id of ['invite-new', 'member-add', 'team-link-open', 'member-role-filter-pill']) await expect(page.getByTestId('members-header').getByTestId(id)).toBeVisible()
    await expect(page.getByTestId('members-table').getByTestId('member-role-bob')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.getByTestId('member-filters-toggle')).toHaveCount(0)
    await page.goto('/admin/groups')
    await expect(page.getByTestId('groups-header').getByTestId('group-new')).toBeVisible()
    await page.goto('/admin/folders')
    await expect(page.getByTestId('folders-header').getByTestId('folder-rule-new')).toBeVisible()
    await expect(page.getByTestId('folders-header').getByTestId('tree-ruled-only')).toBeVisible()
    await page.goto('/admin/usage')
    for (const id of ['usage-limits-link', 'usage-csv', 'usage-filter-user']) await expect(page.getByTestId(id)).toBeVisible()
    await page.goto('/admin/audit')
    await expect(page.getByTestId('activity-kinds')).toBeVisible()
    await expect(page.getByTestId('activity-more-toggle')).toHaveCount(0)
    await page.goto('/admin/settings#ai-limits')
    await expect(page.getByTestId('engine-budgets').getByTestId('budget-new')).toBeVisible()
    await expect(page.getByTestId('company-profile-edit')).toBeVisible()
    await expect(page.getByTestId('admin-bar-actions')).toHaveCount(0)
  })
}
