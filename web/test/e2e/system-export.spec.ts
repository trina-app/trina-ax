// Admin › System › Export (POST /api/admin/export, a job): the owner picks what goes in, may give a password (at least
// 8 characters, or the button waits), starts it and reads where the archive was saved. On a phone it is the Export row's
// own page.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

function exportSection(page: Page): Locator {
  return page.locator('section', { has: page.getByRole('heading', { name: t['system.export'], exact: true }) })
}

async function runExport(section: Locator) {
  await section.getByRole('checkbox', { name: t['system.exportWhat.files'] }).check()
  const start = section.getByRole('button', { name: t['system.exportStart'] })
  // a password shorter than 8 characters: the button waits
  await section.getByLabel(t['system.exportPassword']).fill('short')
  await expect(start).toBeDisabled()
  await section.getByLabel(t['system.exportPassword']).fill('export pass 1')
  await expect(start).toBeEnabled()
  await start.click()
  await expect(section.getByText(/^Saved to users\/olga\/exports\/.+\.tar\.zst\.age\.$/)).toBeVisible()
}

test('the owner exports chats, memories and the team folder with a password and reads where it went', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/system')
  const section = exportSection(page)
  await expect(section.getByRole('checkbox', { name: t['system.exportWhat.chats'] })).toBeChecked()
  await expect(section.getByRole('checkbox', { name: t['system.exportWhat.memories'] })).toBeChecked()
  // nothing picked: nothing to start
  await section.getByRole('checkbox', { name: t['system.exportWhat.chats'] }).uncheck()
  await section.getByRole('checkbox', { name: t['system.exportWhat.memories'] }).uncheck()
  await expect(section.getByRole('button', { name: t['system.exportStart'] })).toBeDisabled()
  await section.getByRole('checkbox', { name: t['system.exportWhat.chats'] }).check()
  await runExport(section)
  expect(realErrors(errors)).toEqual([])
})

test('a phone: the Export row opens its own page, which runs the same export', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.goto('/admin/system')
  await page.getByTestId('system-row-export').click()
  await expect(page).toHaveURL(/\/admin\/system\/export$/)
  const section = page.getByTestId('system-group-export')
  await expect(section).toBeVisible()
  const box = (await section.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await runExport(section)
})
