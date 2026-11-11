// Admin and Settings on a phone (390×844), in a real browser (docs/DECISIONS.md "Admin and Settings on phones: a list
// you tap into"; lib/backStack.ts): Admin opens on a list (no strip, no cards) whose rows push their page under
// "‹ Admin"; ‹ and the browser's back return to the list at the same place; a page opened from a link or a pasted
// address gets the list put under it; a page pushed from the list starts at the top; the 나 list's sections push too, so
// Back returns to the list instead of leaving Settings. From 768 px Admin is a sidebar (a rail of icons on a tablet).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' })

const t = DICTS.en
const historyLength = (page: Page) => page.evaluate(() => history.length)
const scrollTop = (page: Page) => page.getByTestId('admin-content').evaluate((el) => el.scrollTop)

async function openAdmin(page: Page) {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-admin').click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
})

test('the list: whose admin it is, what needs attention, then the groups with values; no strip and no cards', async ({ page }) => {
  await openAdmin(page)
  await expect(page.getByTestId('admin-title')).toHaveText(t['admin.teamTitle'].replace('{team}', 'Acme'))
  await expect(page.getByTestId('page-scope')).toBeVisible()
  await expect(page.getByTestId('admin-menu')).toHaveCount(0)
  await expect(page.getByTestId('admin-home')).toHaveCount(0)
  // the bar: ‹ named after the 나 list it came from, no title (the list has its own)
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['settings.title'])
  for (const id of ['members', 'groups', 'folders', 'providers', 'connectors', 'ai-apps', 'plugins', 'slack', 'usage', 'audit', 'settings', 'system']) {
    const row = page.getByTestId(`admin-row-${id}`)
    await expect(row).toBeAttached()
    expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(48)
  }
  await expect(page.getByTestId('admin-row-members')).toContainText('2')
  await expect(page.getByTestId('admin-row-providers')).toContainText('Claude Code')
  // the fixture's disk is 82% full: one attention row, and System's badge counts exactly that
  await expect(page.getByTestId('attention-storage')).toBeVisible()
  await expect(page.getByTestId('admin-row-system')).toContainText('1 to fix')
  // the owner's setup steps are one row that opens in place
  const steps = page.getByTestId('owner-checklist-toggle')
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
  await steps.click()
  await expect(steps).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-testid^="owner-check-"]').first()).toBeVisible()
  // nothing is wider than the screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('row → page under "‹ Admin" → ‹ and the browser\'s back return to the list at the same place; a pushed page starts at the top', async ({ page }) => {
  await openAdmin(page)
  // far down the list
  await page.getByTestId('admin-content').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(150)
  const down = await scrollTop(page)
  expect(down).toBeGreaterThan(100)
  const length = await historyLength(page)
  await page.getByTestId('admin-row-system').click()
  await expect(page).toHaveURL(/\/admin\/system$/)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['admin.system'])
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.title'])
  await expect.poll(() => scrollTop(page)).toBe(0)
  // ‹: back in the history (no new entry), to the list where it was
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin$/)
  expect(await historyLength(page)).toBe(length + 1)
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(down - 5)
  // the browser's (and the phone's) back does the same
  await page.getByTestId('admin-row-usage').click()
  await expect(page).toHaveURL(/\/admin\/usage$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  // and from the list, Back leaves Admin for the 나 list it came from
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('a pasted address: the page with the lists under it, its query still doing its job; Back → the lists → out', async ({ page }) => {
  await page.goto('/admin/connectors?drive=1')
  // ?drive=1 opens Google Drive's page, which has its own address (pages/admin/adminScreens.ts): Connectors and the
  // Admin list go under it
  await expect(page).toHaveURL(/\/admin\/connectors\/google-drive$/)
  await expect(page.getByTestId('drive-admin-detail')).toBeVisible()
  await expect(page.getByTestId('admin-bar-title')).toHaveText('Google Drive')
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.team.integrations'])
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['admin.team.integrations'])
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.title'])
  await page.goBack()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  // the list is the first entry of this document: ‹ goes to the 나 list in its place
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['settings.title'])
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('a link from inside the app (Settings › Usage → Admin › Usage): the list goes under it; Back → list → where it was', async ({ page }) => {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-row-usage').click()
  await expect(page).toHaveURL(/\/settings\/usage$/)
  await page.getByTestId('my-usage-team-link').click()
  await expect(page).toHaveURL(/\/admin\/usage$/)
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.title'])
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin$/)
  // the list says where Back goes next: the section it was opened from
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['settings.usage'])
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/usage$/)
})

test('a page that opens another (Usage → its limits in Team settings): ‹ names the page it came from; the #hash opens its group', async ({ page }) => {
  await openAdmin(page)
  await page.getByTestId('admin-row-usage').click()
  await page.getByTestId('usage-limits-link').click()
  // on a phone the limits are a group of Team settings of their own (teamSettingsGroups.ts), opened in place of the link
  await expect(page).toHaveURL(/\/admin\/settings\/limits#ai-limits$/)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['budgets.title'])
  await expect(page.getByTestId('engine-budgets')).toBeVisible()
  // inside Admin: no list put under it, Back goes where it came from
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.usage'])
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin\/usage$/)
})

test('Folder permissions: By folder ↔ By person adds no history on a phone', async ({ page }) => {
  await openAdmin(page)
  await page.getByTestId('admin-row-folders').click()
  await expect(page).toHaveURL(/\/admin\/folders$/)
  const length = await historyLength(page)
  await page.getByRole('tab', { name: t['accessView.byPerson'] }).click()
  await expect(page).toHaveURL(/view=people/)
  await page.getByRole('tab', { name: t['accessView.byFolder'] }).click()
  await expect(page).not.toHaveURL(/view=people/)
  expect(await historyLength(page)).toBe(length)
  await page.goBack()
  await expect(page).toHaveURL(/\/admin$/)
})

test('Settings: a section pushes, so Back returns to the list (it left Settings before); its list keeps its place', async ({ page }) => {
  await page.getByTestId('tab-me').click()
  await expect(page).toHaveURL(/\/settings$/)
  const menu = page.getByTestId('settings-menu')
  await menu.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(150)
  const down = await menu.evaluate((el) => el.scrollTop)
  await page.getByTestId('settings-row-about').click()
  await expect(page).toHaveURL(/\/settings\/about$/)
  await expect(page.getByTestId('settings-section-title')).toHaveText(t['settings.about'])
  await expect(page.getByTestId('settings-back-label')).toHaveText(t['settings.title'])
  await page.goBack()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(menu).toBeVisible()
  await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(down - 5)
  // ‹ does the same, without a new entry
  await page.getByTestId('settings-row-security').click()
  const length = await historyLength(page)
  await page.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/\/settings$/)
  expect(await historyLength(page)).toBe(length)
  // a section opened from a pasted address: the list under it
  await page.goto('/settings/apps')
  await page.goBack()
  await expect(page).toHaveURL(/\/settings$/)
})

test('Settings › Notifications from the Activity page\'s gear: ‹ Activity, and Back returns there (no list put between)', async ({ page }) => {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-inbox').click()
  await expect(page).toHaveURL(/\/activity$/)
  await page.getByTestId('activity-settings-phone').click()
  await expect(page).toHaveURL(/\/settings\/notifications$/)
  await expect(page.getByTestId('settings-section-title')).toHaveText(t['notifications.title'])
  await expect(page.getByTestId('settings-back-label')).toHaveText(t['inbox.title'])
  const length = await historyLength(page)
  await page.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/\/activity$/)
  expect(await historyLength(page)).toBe(length)
})

test('a member: /admin goes home and leaves no list behind', async ({ page }) => {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-logout').click()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/members')
  await expect(page).not.toHaveURL(/\/admin/)
  await page.goBack()
  await expect(page).not.toHaveURL(/\/admin/)
})

test('an admin who is not the owner: Slack\'s address goes to the list, one entry', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await signIn(page, { username: 'dana', password: 'dana password 1' })
  await page.goto('/admin/slack')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-row-slack')).toHaveCount(0)
  await page.goBack()
  await expect(page).not.toHaveURL(/\/admin/)
})

test('nothing is wider than the screen on any Admin page, in Spanish too', async ({ page }) => {
  for (const locale of ['en', 'es'] as const) {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    for (const id of ['', 'members', 'groups', 'folders', 'providers', 'connectors', 'ai-apps', 'plugins', 'slack', 'usage', 'audit', 'settings', 'system']) {
      await page.goto(id ? `/admin/${id}` : '/admin')
      await expect(page.getByTestId('admin-content')).toBeVisible()
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${locale} /admin/${id}`).toBeLessThanOrEqual(390)
      expect(await page.getByTestId('admin-content').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${locale} /admin/${id}`).toBe(true)
    }
  }
})

test.describe('from 768 px', () => {
  test.use({ viewport: { width: 820, height: 1000 }, hasTouch: false, isMobile: false })
  test('a tablet: the sidebar as a rail of icons with their names beside the page, no strip, no list', async ({ page }) => {
    await page.goto('/admin/members')
    const side = page.getByTestId('admin-sidebar')
    await expect(side).toBeVisible()
    await expect(side).toHaveAttribute('data-rail', '')
    await expect(page.getByTestId('admin-phone-root')).toHaveCount(0)
    await expect(page.getByTestId('phone-page-bar')).toHaveCount(0)
    // a column, never a sideways strip
    const menu = page.getByTestId('admin-menu')
    expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await expect(menu.getByRole('link', { name: t['admin.members'] })).toHaveAttribute('aria-current', 'page')
    // the names show under the icons (a finger has no hover for a tip)
    await expect(menu.getByText(t['admin.folders'], { exact: true })).toBeVisible()
    // the page keeps room beside the app's sidebar and the rail
    expect((await page.getByTestId('admin-content').boundingBox())!.width).toBeGreaterThan(420)
    await menu.getByRole('link', { name: t['admin.groups'] }).click()
    await expect(page).toHaveURL(/\/admin\/groups$/)
  })
})

test.describe('a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
  test('the named sidebar and Home, as before', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByTestId('admin-sidebar')).not.toHaveAttribute('data-rail', '')
    await expect(page.getByTestId('admin-menu').getByText(t['admin.members'])).toBeVisible()
    await expect(page.getByTestId('admin-home')).toBeVisible()
  })
})
