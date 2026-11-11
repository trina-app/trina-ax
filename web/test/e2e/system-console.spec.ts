// Admin › System laid out like a settings document (Team settings, the Claude Console): plain sections under headings,
// no boxes; the owner sees every section in a fixed order, an admin only the plan, storage and office updates; the
// server checks that need attention come first and the ones that passed fold into one line.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { reset, signIn, watchConsole, realErrors } from './helpers'

const t = DICTS.en

async function sectionTitles(page: Page) {
  return page.getByTestId('system-page').locator(':scope > section > header h2').allInnerTexts()
}

test('owner: every section in order, as plain sections without boxes', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/system')
  await expect(page.getByTestId('system-health')).toBeVisible()
  await expect(page.getByTestId('backup-now')).toBeVisible()
  expect(await sectionTitles(page)).toEqual([t['storage.title'], t['system.updates'], t['system.health'], t['system.connection'], t['connected.title'], t['system.backups'], t['system.export']])
  // no section is a box: no border radius, no border but the hairline on top, no surface colour of its own
  for (const s of await page.getByTestId('system-page').locator(':scope > section').all()) {
    const st = await s.evaluate((el) => { const c = getComputedStyle(el); return { radius: c.borderTopLeftRadius, side: c.borderLeftWidth } })
    expect(st).toEqual({ radius: '0px', side: '0px' })
  }
  // version and updates as label / value rows
  await expect(page.getByTestId('system-update')).toContainText(t['system.version'])
  await expect(page.getByTestId('system-update')).toContainText(t['system.upToDate'])
  // the connected folders' long explanation sits behind Learn more
  const folders = page.locator('section', { has: page.getByRole('heading', { name: t['connected.title'] }) })
  await expect(folders.getByText(t['connected.desc'])).toBeHidden()
  await folders.getByRole('button', { name: t['teamSettings.learnMore'] }).click()
  await expect(folders.getByText(t['connected.desc'])).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('health: what needs attention first, the passed checks behind Show details', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/system')
  const list = page.getByTestId('diagnostics')
  // the relay warning is the first row and visible; the passed disk check is folded
  await expect(list.locator(':scope > li').first()).toHaveAttribute('data-status', 'warn')
  await expect(list.locator(':scope > li').first()).toContainText('Relay connection')
  await expect(list).toContainText('1 check passed')
  const passed = list.locator('[data-status="ok"]')
  await expect(passed).toBeHidden()
  const toggle = page.getByTestId('health-details')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(passed).toBeVisible()
  await expect(passed).toContainText(t['adminux.system.diskCheck'])
})

test('an admin sees the plan, storage and office updates only', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  expect((await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' } })).ok()).toBe(true)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/system')
  await expect(page.getByTestId('storage')).toBeVisible()
  expect(await sectionTitles(page)).toEqual([t['storage.title']])
  await expect(page.getByTestId('system-health')).toHaveCount(0)
  await expect(page.getByTestId('backup-now')).toHaveCount(0)
})

test('phone: a fact\'s value on the right of its label, nothing runs off the side', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.goto('/admin/system')
  await expect(page.getByTestId('system-health')).toBeVisible()
  const wide = await page.getByTestId('admin-content').evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  expect(wide).toBe(false)
  // a fact's value sits on its label's line, at the right (as a phone's Settings › About; docs/DECISIONS.md "Admin and
  // Settings on phones", the form pages)
  const row = page.getByTestId('system-facts').locator(':scope > div').first()
  const [label, value] = await Promise.all([row.locator('dt').boundingBox(), row.locator('dd').first().boundingBox()])
  expect(Math.abs(value!.y - label!.y)).toBeLessThan(4)
  expect(value!.x).toBeGreaterThan(label!.x + label!.width)
})
