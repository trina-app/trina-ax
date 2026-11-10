// Admin › Team settings laid out like a settings document: plain sections, one row per setting (its name, a short line,
// the control on the right), the long text behind "Learn more", and a save bar that shows only while something is not
// saved. Same settings, same PATCH as before (pages/admin/TeamSettings.tsx).
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

async function open(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-settings-general')).toBeVisible()
}

async function audit(page: Page, where: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('sections and rows: a short line under each setting, the control on the right, no long paragraph on top', async ({ page }) => {
  const errors = watchConsole(page)
  await open(page)
  for (const [id, key] of [['team-settings-general', 'teamSettings.section.general'], ['team-settings-time', 'teamSettings.section.time'], ['team-settings-data', 'teamSettings.section.data'], ['team-settings-ai', 'teamSettings.section.ai'], ['team-speech', 'speech.title']] as const) {
    await expect(page.getByTestId(id).getByRole('heading', { level: 2 }).first()).toHaveText(t[key])
  }
  // the old paragraph about how saving works is gone; nothing to save yet, so no save bar
  await expect(page.getByTestId('team-settings-savebar')).toHaveCount(0)
  // every field is labelled by its row's name and described by its short line
  await expect(page.getByLabel(t['teamSettings.timeZone'], { exact: true })).toHaveAccessibleDescription(t['teamSettings.row.timeZoneDesc'])
  await expect(page.getByLabel(t['teamSettings.row.trash'], { exact: true })).toHaveAccessibleDescription(t['teamSettings.row.trashDesc'])
  await expect(page.getByRole('checkbox', { name: t['teamSettings.aiVision'] })).toHaveAccessibleDescription(t['teamSettings.row.aiVisionDesc'])
  // the warning that matters stays in the short line: images go to the AI provider
  await expect(page.getByTestId('team-ai-vision')).toContainText(t['teamSettings.row.aiVisionDesc'])
  // the control sits to the right of the words on a wide screen
  const row = page.getByTestId('team-ai-subagents')
  const label = await row.getByText(t['teamSettings.aiSubagents'], { exact: true }).boundingBox()
  const knob = await row.locator('input[type="checkbox"] + span').boundingBox()
  expect(knob!.x).toBeGreaterThan(label!.x + 300)
  // days fields say their unit
  await expect(page.getByTestId('team-settings-data')).toContainText(t['teamSettings.days'])
  expect(realErrors(errors)).toEqual([])
})

test('Learn more opens the long text and closes it again', async ({ page }) => {
  await open(page)
  const row = page.getByTestId('team-ai-subagents')
  const more = page.getByTestId('team-ai-subagents-more')
  await expect(row.getByText(t['teamSettings.aiSubagentsHint'])).toBeHidden()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(row.getByText(t['teamSettings.aiSubagentsHint'])).toBeVisible()
  await more.click()
  await expect(row.getByText(t['teamSettings.aiSubagentsHint'])).toBeHidden()
})

test('a change shows the save bar; Cancel puts the form back, Save sends only what changed', async ({ page }) => {
  await open(page)
  const bar = page.getByTestId('team-settings-savebar')
  const trash = page.getByLabel(t['teamSettings.row.trash'], { exact: true })
  const before = await trash.inputValue()
  await trash.fill('45')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText(t['teamSettings.unsaved'])
  // the bar is on screen even though the field may be far up the page
  expect((await bar.boundingBox())!.y + 10).toBeLessThan(page.viewportSize()!.height)
  await bar.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(bar).toHaveCount(0)
  await expect(trash).toHaveValue(before)

  const patches: unknown[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings') patches.push(r.postDataJSON()) })
  await page.getByTestId('team-personal-integrations').locator('label').first().click()
  await trash.fill('45')
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings')
  await bar.getByRole('button', { name: t['common.save'], exact: true }).click()
  expect((await saved).ok()).toBe(true)
  expect(patches).toEqual([{ trashRetentionDays: 45, personalIntegrations: false }])
  await expect(bar).toHaveCount(0)
  await page.reload()
  await expect(trash).toHaveValue('45')
  await expect(page.getByTestId('team-personal-integrations')).toHaveAttribute('data-on', 'false')
})

test('a field that needs a fix: the bar says so and takes you there', async ({ page }) => {
  await open(page)
  const bar = page.getByTestId('team-settings-savebar')
  await page.getByLabel(t['teamSettings.updateWindow'], { exact: true }).fill('25:00-26:00')
  await expect(bar).toContainText(t['adminux.settings.needsFix'])
  await expect(bar.getByRole('button', { name: t['common.save'], exact: true })).toBeDisabled()
  await page.getByTestId('team-settings-go-fix').click()
  await expect(page.getByLabel(t['teamSettings.updateWindow'], { exact: true })).toBeFocused()
})

test('an admin who is not the owner sees the team name but cannot change it', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  expect((await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' } })).ok()).toBe(true)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/settings')
  const name = page.getByLabel(t['setup.teamName'], { exact: true })
  await expect(name).toBeDisabled()
  await expect(name).toHaveAccessibleDescription(t['teamSettings.nameOwnerOnly'])
})

test('phone width: a group per page, a switch on the right of its name, nothing scrolls sideways, the save bar stays reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  // a phone: Team settings is a list of its groups (pages/admin/teamSettingsGroups.ts)
  await page.goto('/admin/settings/members')
  const row = page.getByTestId('team-ai-vision')
  const label = (await row.getByText(t['teamSettings.aiVision'], { exact: true }).boundingBox())!
  const knob = (await row.locator('input[type="checkbox"] + span').boundingBox())!
  expect(knob.x).toBeGreaterThan(label.x + label.width - 1)
  expect(Math.abs(knob.y - label.y)).toBeLessThan(12)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.goto('/admin/settings/data')
  await page.getByLabel(t['teamSettings.row.audit'], { exact: true }).fill('120')
  const bar = page.getByTestId('team-settings-savebar')
  await expect(bar).toBeInViewport()
  await expect(bar.getByRole('button', { name: t['common.save'], exact: true })).toBeInViewport()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await open(page)
    await audit(page, `team settings (${scheme})`)
    await page.getByTestId('team-ai-vision-more').click()
    await page.getByLabel(t['teamSettings.row.chatTrash'], { exact: true }).fill('9')
    await expect(page.getByTestId('team-settings-savebar')).toBeVisible()
    await audit(page, `team settings with Learn more open and the save bar (${scheme})`)
  })
}
