// The sidebar sized like Claude's, the account menu above the profile line (who is signed in, Settings, Usage,
// Appearance, Sign out) and Settings as a dialog over the page it was opened from (components/Sidebar.tsx,
// components/settings/SettingsDialog.tsx, App.tsx useSettingsOverlay): addresses, Esc and ✕, the keyboard staying in
// the dialog and coming back, the search, a phone's full-screen list, and no serious accessibility problems.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('the sidebar is as wide as Claude\'s, with 14 px rows of 32 px', async ({ page }) => {
  await start(page)
  const side = page.getByRole('navigation', { name: t['sidebar.label'] })
  // the column is 280 px, its right border included
  expect(Math.round((await side.locator('..').boundingBox())!.width)).toBe(280)
  const projects = side.getByRole('link', { name: t['sidebar.projects'] })
  expect(Math.round((await projects.boundingBox())!.height)).toBe(32)
  expect(await projects.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px')
  expect(await side.getByRole('heading', { name: t['sidebar.recents'] }).evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px')
})

test('the account menu opens above the profile line, moves with the keyboard and changes the appearance', async ({ page }) => {
  await start(page)
  const button = page.getByTestId('account-menu')
  await button.click()
  const menu = page.getByTestId('account-dropdown')
  await expect(menu).toBeVisible()
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThanOrEqual((await button.boundingBox())!.y + 1)
  await expect(page.getByTestId('account-who')).toHaveText(/\S/)
  await expect(menu.getByRole('menuitem')).toHaveText([t['sidebar.settings'], t['sidebar.usage'], t['sidebar.appearance'], t['auth.logout']])
  await expect(menu.getByRole('menuitem', { name: t['sidebar.settings'] })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: t['sidebar.usage'] })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByTestId('logout')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(button).toBeFocused()

  await button.click()
  await page.getByTestId('account-appearance').click()
  await page.getByTestId('account-theme-dark').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByTestId('account-theme-dark')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('account-theme-light').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await audit(page, 'account menu')
  // Usage is Admin > Usage
  await page.getByTestId('account-usage').click()
  await expect(page).toHaveURL(/\/admin\/usage$/)
})

test('Settings opens as a dialog over the page, keeps the keyboard inside, and Esc or ✕ goes back', async ({ page }) => {
  await start(page)
  await page.getByRole('link', { name: t['sidebar.projects'] }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-settings').click()
  await expect(page).toHaveURL(/\/settings$/)
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await expect(dialog).toBeVisible()
  // the page it was opened from stays under it
  await expect(page.getByRole('heading', { level: 1, name: t['projects.title'] })).toBeAttached()
  await expect(dialog.getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
  // the keyboard stays in the dialog
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  // the search narrows the list by name; a section opens on the right and the address follows
  await dialog.getByTestId('settings-search').fill('mc')
  await expect(dialog.getByTestId('settings-menu').getByRole('link')).toHaveText(['MCP'])
  await dialog.getByTestId('settings-menu').getByRole('link', { name: 'MCP' }).click()
  await expect(page).toHaveURL(/\/settings\/integrations$/)
  await expect(dialog.getByTestId('connectors-header').getByRole('heading', { name: 'MCP' })).toBeVisible()
  await dialog.getByTestId('settings-search').fill('zzz')
  await expect(dialog.getByTestId('settings-no-match')).toBeVisible()
  // Esc: back to the page under it, and the keyboard back on the account button
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('account-menu')).toBeFocused()
  // the browser's back button after closing does not open it again
  await page.goBack()
  await expect(page.getByRole('dialog', { name: t['settings.title'] })).toHaveCount(0)
})

test('a Settings address opened directly shows the dialog over Home; ✕ closes it there', async ({ page }) => {
  await start(page)
  await page.goto('/settings/memory')
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await expect(dialog.getByRole('heading', { name: t['settings.memory'] })).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeAttached()
  await page.getByTestId('settings-close').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
  // an address that is not a section opens the profile
  await page.goto('/settings/nothing-here')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('dialog').getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
})

test('on a phone Settings fills the screen: the list, then a section with a way back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await start(page)
  await page.goto('/settings')
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  const box = (await dialog.boundingBox())!
  expect(Math.round(box.width)).toBe(390)
  await expect(dialog.getByTestId('settings-menu')).toBeVisible()
  await expect(dialog.getByTestId('settings-content')).toBeHidden()
  await dialog.getByTestId('settings-menu').getByRole('link', { name: t['settings.profile'] }).click()
  await expect(page).toHaveURL(/\/settings\/profile$/)
  await expect(dialog.getByTestId('settings-menu')).toBeHidden()
  await expect(dialog.getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
  await dialog.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(dialog.getByTestId('settings-menu')).toBeVisible()
  await audit(page, 'settings list at phone width')
  await page.getByTestId('settings-close').click()
  await expect(dialog).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the Settings dialog has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await start(page)
    for (const path of ['/settings/profile', '/settings/integrations', '/settings/notifications']) {
      await page.goto(path)
      await expect(page.getByRole('dialog', { name: t['settings.title'] })).toBeVisible()
      await page.waitForTimeout(300)
      await audit(page, `${path} ${scheme}`)
    }
  })
}
