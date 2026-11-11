// The layout fixes of the quick UX check (2026-11-04), in the browser: Admin › Members is a card per member on a phone
// with the actions behind "…"; Admin › System's facts do not wrap at a laptop width; Admin › MCP says what it is for
// under its title; a plugin's long licence list is "Licenses"; a sideways row of tabs fades at a cut edge and keeps a
// margin before the chosen tab; the Files search box takes the free width on a phone.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const PHONE = { width: 390, height: 844 }
const box = async (l: Locator) => (await l.boundingBox())!
const lines = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))
const fade = (l: Locator) => l.evaluate((el) => [el.hasAttribute('data-fade-start'), el.hasAttribute('data-fade-end')])

async function phone(page: Page) {
  await page.setViewportSize(PHONE)
}

test('Admin › Members on a phone: a card per member, the actions behind "…"; the table on a wide screen', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await phone(page)
  await page.goto('/admin/members')
  const list = page.getByTestId('members-list')
  await expect(list).toBeVisible()
  await expect(page.getByTestId('members-table')).toHaveCount(0)
  const bob = page.getByTestId('member-card-bob')
  await expect(bob).toContainText('Bob')
  await expect(bob).toContainText(t['role.member'])
  // nothing sticks out of the screen, and the name is one line
  const card = await box(bob)
  expect(card.x + card.width).toBeLessThanOrEqual(PHONE.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  expect(await lines(bob.locator('p').first())).toBe(1)
  // the owner (yourself): the "…" has only "Folders they see" (no actions on yourself)
  await page.getByTestId('member-card-olga').getByTestId('member-more').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([t['accessView.membersLink']])
  await page.keyboard.press('Escape')
  // "…" opens the actions inside the screen; Reset password opens its dialog
  await bob.getByTestId('member-more').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const m = await box(menu)
  expect(m.x).toBeGreaterThanOrEqual(0)
  expect(m.x + m.width).toBeLessThanOrEqual(PHONE.width)
  await expect(menu.getByRole('menuitem')).toHaveText([t['accessView.membersLink'], t['common.edit'], t['members.reset'], t['members.resetLinkButton'], t['members.disable'], t['common.delete']])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(bob.getByTestId('member-more')).toBeFocused()
  await bob.getByTestId('member-more').click()
  await page.getByTestId('reset-password-bob').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  // the dialog gives focus back to "…" (the menu item it came from is gone)
  await expect(bob.getByTestId('member-more')).toBeFocused()
  // wide again: the table
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('members-table')).toContainText('Bob')
  await expect(page.getByTestId('members-list')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('Admin › System at 1280: the server facts are one row each, every value on one line', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/admin/system')
  const values = page.getByTestId('system-facts').locator('dd')
  await expect(values).toHaveCount(3)
  for (const v of await values.all()) expect(await lines(v)).toBe(1)
})

test('Admin › Connectors: "applies to everyone in the team" above the title; nothing between the title and the list', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  const scope = page.getByTestId('admin-content').getByTestId('page-scope')
  await expect(scope).toHaveText(t['scope.teamName'].replace('{team}', 'Acme'))
  const header = await box(page.getByTestId('connectors-header'))
  // above the title row, and not under it (the row is filled, it would hide the line's descenders)
  const s = await box(scope)
  expect(s.y + s.height).toBeLessThanOrEqual(header.y + 0.5)
  // the title is the same noun as Settings', with nothing beside it; no line and no card for requests under it (asking a
  // member is in Add connection's menu): Discover starts right under the title
  await expect(page.getByTestId('connectors-header').getByRole('heading', { name: t['admin.integrations'], exact: true })).toBeVisible()
  await expect(page.getByTestId('page-scope')).toHaveCount(1)
  await expect(page.getByTestId('team-integrations-note')).toHaveCount(0)
  expect((await box(page.getByTestId('connector-discover'))).y - (header.y + header.height)).toBeLessThan(40)
})

test('Admin › Plugins: a long licence list is "Licenses", the list in its tooltip and under the line when pressed', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/plugins')
  // the licences are on the plugin's page
  await page.locator('[data-testid="plugin-catalog"][data-plugin="app.trina.hwp-preview"]').getByTestId('plugin-open').click()
  const button = page.getByTestId('plugin-licenses').first()
  await expect(button).toHaveText(t['plugins.licenses'])
  await expect(button).toHaveAttribute('title', /^MIT AND Apache-2\.0 AND /)
  await expect(page.getByText('MIT AND Apache-2.0 AND BSD-3-Clause', { exact: false })).toHaveCount(0)
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator(`[id="${await button.getAttribute('aria-controls')}"]`)).toContainText('LicenseRef-HWP-Notices')
  await expect(page.getByTestId('plugin-license-list').first()).toContainText('LicenseRef-HWP-Notices')
})

test('a phone: a cut row of tabs fades at that edge and keeps a margin before the chosen tab', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await phone(page)
  // the Admin menu, opened on an item far to the right
  await page.goto('/admin/usage')
  const nav = page.getByTestId('admin-menu')
  await expect(nav.locator('[aria-current="page"]')).toBeVisible()
  await expect.poll(() => fade(nav)).toEqual([true, true])
  const r = await box(nav)
  const active = await box(nav.locator('[aria-current="page"]'))
  expect(active.x).toBeGreaterThanOrEqual(r.x + 16)
  expect(active.x + active.width).toBeLessThanOrEqual(r.x + r.width - 16)
  // the start of the menu: only the end fades
  await page.goto('/admin')
  await expect.poll(() => fade(nav)).toEqual([false, true])
  // the search palette's type tabs
  await page.keyboard.press('ControlOrMeta+k')
  const tabs = page.getByTestId('search-palette').getByRole('tablist')
  await expect(tabs).toBeVisible()
  await expect.poll(() => fade(tabs)).toEqual([false, true])
  await tabs.evaluate((el) => { el.scrollLeft = el.scrollWidth })
  await expect.poll(() => fade(tabs)).toEqual([true, false])
})

test('Files on a phone: the search box takes the width the buttons leave, its placeholder whole', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await phone(page)
  await page.goto('/files')
  const input = page.getByTestId('content-search-input')
  await expect(input).toBeVisible()
  const field = await box(input.locator('xpath=..'))
  // starts at the page's left margin, not after a gap
  expect(field.x).toBeLessThanOrEqual(17)
  const fits = await input.evaluate((el: HTMLInputElement) => {
    const c = document.createElement('canvas').getContext('2d')!
    c.font = getComputedStyle(el).font
    return c.measureText(el.placeholder).width <= el.clientWidth
  })
  expect(fits).toBe(true)
})
