// The Trina history's view (docs/decisions/20261122-history-view-per-person.md): Group by: Date by default on the
// computer too, each date folds (kept on the account), Reset to defaults is in the menu only while the view differs and
// resets only the view (never a section or a fold), and the view follows the person to another device.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { openPhoneDrawer } from './nav'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
async function chat(page: Page, title: string) {
  const r = await post(page, '/api/chats', { title })
  expect(r.ok()).toBeTruthy()
}
const panel = (page: Page) => page.getByTestId('trina-panel')

test('a computer (1440): by date by default; a date folds and stays folded; Reset to defaults; another device has the view', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await chat(page, 'QA notes')
  await chat(page, 'Weekly notes')
  await page.reload()
  const p = panel(page)
  // the panel at rest: 트리나 기록 by date
  const today = p.getByTestId('trina-other').getByTestId('history-date').filter({ hasText: t['sidebar.today'] })
  await expect(today).toBeVisible()
  await expect(today.locator('li')).toHaveCount(2)
  // the menu says Date, no Reset while nothing differs
  await page.getByTestId('recents-filter').click()
  await expect(page.getByTestId('recents-view-group')).toContainText(t['sidebar.group.date'])
  await expect(page.getByTestId('recents-reset')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // a date folds, with its count, and stays folded after a reload (the account's folds)
  await today.getByTestId('history-date-fold').click()
  await expect(today.locator('li')).toHaveCount(0)
  await expect(today.getByTestId('history-date-count')).toHaveText('2')
  await page.reload()
  await expect(p.getByTestId('trina-other').getByTestId('history-date').first()).toHaveAttribute('data-folded', '')
  await p.getByTestId('trina-other').getByTestId('history-date-fold').first().click()

  // Group by: None, then Reset to defaults from the menu: back to Date; the fold choice is untouched
  await page.getByTestId('recents-filter').click()
  await page.getByTestId('recents-view-group').click()
  await page.getByTestId('recents-group-none').click()
  await expect(p.getByTestId('recents-list').getByTestId('history-date')).toHaveCount(0)
  await expect(page.getByTestId('recents-filter-dot')).toBeVisible()

  // another device (a new browser, the same account) has Group by: None from the account
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const page2 = await other.newPage()
  await page2.setViewportSize({ width: 1440, height: 900 })
  await signIn(page2)
  await page2.getByTestId('recents-filter').click()
  await expect(page2.getByTestId('recents-view-group')).toContainText(t['sidebar.group.none'])
  await other.close()

  if (!(await page.getByTestId('recents-filter-menu').isVisible())) await page.getByTestId('recents-filter').click()
  await page.getByTestId('recents-reset').click()
  await expect(page.getByTestId('recents-filter-dot')).toHaveCount(0)
  await expect(p.getByTestId('trina-other').getByTestId('history-date').first()).toBeVisible()
})

test('a phone (390): the drawer keeps its own view; Reset to defaults in its sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await chat(page, 'QA notes')
  await page.goto('/')
  const drawer = await openPhoneDrawer(page)
  await expect(drawer.getByTestId('history-date').first()).toBeVisible()
  await drawer.getByTestId('recents-filter').click()
  await expect(page.getByTestId('recents-reset')).toHaveCount(0)
  await page.getByTestId('recents-view-sort').click()
  await page.getByTestId('recents-sort-title').click()
  await drawer.getByTestId('recents-filter').click()
  await page.getByTestId('recents-reset').click()
  await expect(drawer.getByTestId('recents-filter-dot')).toHaveCount(0)
})
