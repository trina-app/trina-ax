// The form pages on a phone (390×844; docs/DECISIONS.md "Admin and Settings on phones", the form pages): Admin › Team
// settings is a list of its groups, each its own page under "‹ Team settings" (pages/admin/teamSettingsGroups.ts), and
// Back returns to the list; a link to a part of it (#ai-limits, #speech) opens the group that holds it, with the lists
// under it; unsaved changes stay with the list and come back after Team settings was left. Rows keep a switch on the
// right of its name with the line under the name; System's values sit on the right; the buttons are 44 px; nothing on
// these pages is wider than the screen. A computer keeps the one page.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' })

const t = DICTS.en
const GROUPS = ['general', 'data', 'members', 'voice', 'ai', 'limits', 'file-list', 'company']
const historyLength = (page: Page) => page.evaluate(() => history.length)

/** The desktop app's bridge with only what Settings › Browser reads (browser-settings.spec.ts has the full one). */
function fakeDesktop() {
  const s = { siteAccess: 'ask', always: ['naver.com', 'place.map.kakao.com'], privateAlways: ['192.168.0.20'], teamAllowsAll: true }
  const noop = () => {}
  ;(window as unknown as { mycelDesktop: unknown }).mycelDesktop = {
    bridgeVersion: 1, appVersion: '0.2.3', platform: 'darwin',
    browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
    pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
    connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
    notify: noop, openTeams: noop, setLocale: noop,
    browserSettings: { get: async () => structuredClone(s), onChange: () => noop, setAccess: async () => 'unchanged', removeSite: async () => structuredClone(s), clearSites: async () => structuredClone(s) },
  }
}

async function openTeamSettings(page: Page) {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-admin').click()
  await page.getByTestId('admin-row-settings').click()
  await expect(page).toHaveURL(/\/admin\/settings$/)
  await expect(page.getByTestId('team-settings-list')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
})

test('Team settings: a list of its groups; a row opens its page under "‹ Team settings"; ‹ and Back return to the list', async ({ page }) => {
  await openTeamSettings(page)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['admin.settings'])
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.title'])
  for (const id of GROUPS) await expect(page.getByTestId(`team-settings-row-${id}`)).toBeVisible()
  // the dev environment is a group only where the server has it
  await expect(page.getByTestId('team-settings-row-dev-env')).toHaveCount(0)
  // the list only: no setting of any group is on it
  await expect(page.getByTestId('team-settings')).toHaveCount(0)
  // the whole list fits on the first screen (it was 6,700 px of settings)
  expect((await page.getByTestId('team-settings-row-company').boundingBox())!.y).toBeLessThan(844 - 60)

  const length = await historyLength(page)
  await page.getByTestId('team-settings-row-general').click()
  await expect(page).toHaveURL(/\/admin\/settings\/general$/)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['teamSettings.section.general'])
  await expect(page.getByTestId('admin-back')).toHaveAccessibleName(t['tabs.backTo'].replace('{page}', t['admin.settings']))
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.settings'])
  // that group only, its name said once (the bar), kept for screen readers on the page
  await expect(page.locator('#ts-name')).toBeVisible()
  await expect(page.getByTestId('team-settings-data')).toHaveCount(0)
  await expect(page.getByTestId('team-ai-settings')).toHaveCount(0)
  expect((await page.locator('#ts-general-title').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
  await expect(page.locator('#ts-time-title')).toBeVisible()
  // ‹ goes back in the history (no new entry) to the list
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin\/settings$/)
  expect(await historyLength(page)).toBe(length + 1)
  // the phone's (and the browser's) Back does the same
  await page.getByTestId('team-settings-row-limits').click()
  await expect(page).toHaveURL(/\/admin\/settings\/limits$/)
  await expect(page.getByTestId('engine-budgets')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/settings$/)
  await expect(page.getByTestId('team-settings-list')).toBeVisible()
  // and from the list, Back goes to Admin's list
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin$/)
})

test('unsaved changes: the save bar stays at the bottom, on the list too; leaving Team settings keeps them', async ({ page }) => {
  await openTeamSettings(page)
  await page.getByTestId('team-settings-row-general').click()
  await page.locator('#ts-name').fill('Acme Labs')
  const bar = page.getByTestId('team-settings-savebar')
  await expect(bar).toBeVisible()
  const b = (await bar.boundingBox())!
  expect(b.y + b.height).toBeLessThanOrEqual(844)
  // the list says there is something to save
  await page.getByTestId('admin-back').click()
  await expect(page.getByTestId('team-settings-list')).toBeVisible()
  await expect(bar).toBeVisible()
  // a group that saves on its own has no bar
  await page.getByTestId('team-settings-row-limits').click()
  await expect(page.getByTestId('engine-budgets')).toBeVisible()
  await expect(bar).toHaveCount(0)
  await page.getByTestId('admin-back').click()
  // out of Team settings and back: the change is still there, with its bar
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin$/)
  await page.getByTestId('admin-row-settings').click()
  await expect(bar).toBeVisible()
  await page.getByTestId('team-settings-row-general').click()
  await expect(page.locator('#ts-name')).toHaveValue('Acme Labs')
  await bar.getByRole('button', { name: t['common.save'] }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.locator('#ts-name')).toHaveValue('Acme Labs')
})

test('a group that saves on its own keeps its draft too: AI defaults, Back to the list and in again', async ({ page }) => {
  await openTeamSettings(page)
  await page.getByTestId('team-settings-row-ai').click()
  await page.getByTestId('engines-concurrency').fill('3')
  await expect(page.getByTestId('engine-defaults-save-bar')).toBeVisible()
  await page.getByTestId('admin-back').click()
  await page.getByTestId('team-settings-row-ai').click()
  await expect(page.getByTestId('engines-concurrency')).toHaveValue('3')
  await expect(page.getByTestId('engine-defaults-save-bar')).toBeVisible()
})

test('the dev environment, where the server has it: its own group', async ({ page }) => {
  expect((await page.request.post('/__test/dev-env', { data: { srt: true } })).ok()).toBe(true)
  await page.goto('/admin/settings')
  await page.getByTestId('team-settings-row-dev-env').click()
  await expect(page).toHaveURL(/\/admin\/settings\/dev-env$/)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['devEnv.title'])
  await expect(page.getByTestId('dev-env-team')).toBeVisible()
  await expect(page.getByTestId('team-settings-general')).toHaveCount(0)
})

test('a field to fix: "Go to the field" from the list opens General at that field', async ({ page }) => {
  await openTeamSettings(page)
  await page.getByTestId('team-settings-row-general').click()
  await page.locator('#ts-name').fill('')
  await page.getByTestId('admin-back').click()
  await page.getByTestId('team-settings-go-fix').click()
  await expect(page).toHaveURL(/\/admin\/settings\/general$/)
  await expect(page.locator('#ts-name')).toBeFocused()
})

test('a link to a setting opens the group that holds it, with the lists under it: a pasted address, a page inside Admin', async ({ page }) => {
  // a pasted address (the first entry): Usage limits, then Back → Team settings → Admin
  await page.goto('/admin/settings#ai-limits')
  await expect(page).toHaveURL(/\/admin\/settings\/limits#ai-limits$/)
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['budgets.title'])
  await expect(page.getByTestId('engine-budgets')).toBeVisible()
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.settings'])
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/settings$/)
  await expect(page.getByTestId('team-settings-list')).toBeVisible()
  await expect(page.getByTestId('admin-back-label')).toHaveText(t['admin.title'])
  await page.goBack()
  await expect(page).toHaveURL(/\/admin$/)
  // Voice input's own link (the mic's "voice input is off")
  await page.goto('/admin/settings#speech')
  await expect(page).toHaveURL(/\/admin\/settings\/voice#speech$/)
  await expect(page.getByTestId('team-speech')).toBeVisible()
  await expect(page.getByTestId('team-settings-general')).toHaveCount(0)
  // the old Providers tab's address: the AI engine's group
  await page.goto('/admin/providers?tab=team')
  await expect(page).toHaveURL(/\/admin\/settings\/ai#ai$/)
  await expect(page.getByTestId('engine-defaults')).toBeVisible()
  await expect(page.getByTestId('engine-budgets')).toHaveCount(0)
  // System's "update window" link: General, at Time and updates
  await page.goto('/admin/settings#ts-time')
  await expect(page).toHaveURL(/\/admin\/settings\/general#ts-time$/)
  await expect(page.locator('#ts-time-title')).toBeInViewport()
  // an unknown group, or a hash that is no escape: the list
  await page.goto('/admin/settings#%')
  await expect(page.getByTestId('team-settings-list')).toBeVisible()
  await page.goto('/admin/settings/nope')
  await expect(page).toHaveURL(/\/admin\/settings$/)
  await expect(page.getByTestId('team-settings-list')).toBeVisible()
})

test('switches sit on the right of their name, the line under the name; short numbers on the right too', async ({ page }) => {
  await page.goto('/admin/settings/members')
  const rows = page.locator('[data-testid="team-settings-ai"] [data-on]')
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeGreaterThanOrEqual(6)
  for (const row of await rows.all()) {
    const name = (await row.locator('label').first().boundingBox())!
    const line = (await row.locator('[id$="-desc"]').first().boundingBox())!
    const sw = (await row.locator('input[type="checkbox"]').locator('..').boundingBox())!
    expect(sw.x, 'the switch is right of the name').toBeGreaterThanOrEqual(name.x + name.width - 1)
    expect(sw.x + sw.width).toBeLessThanOrEqual(390 - 15)
    expect(Math.abs(sw.y - name.y), 'on the name\'s line').toBeLessThan(12)
    expect(line.y, 'the line under the name').toBeGreaterThan(name.y + 10)
    expect(line.x).toBeCloseTo(name.x, 0)
    expect(line.x + line.width, 'the line does not run under the switch').toBeLessThanOrEqual(sw.x)
  }
  const steps = (await page.locator('#ts-answer-step-limit').boundingBox())!
  expect(steps.x + steps.width).toBeGreaterThan(390 - 30)
  expect(steps.x).toBeGreaterThan(195)
})

test('System: values on the right of their label, long ones under it; its buttons are 44 px', async ({ page }) => {
  await page.goto('/admin/system')
  const facts = page.getByTestId('system-facts')
  await expect(facts).toBeVisible()
  for (const row of await facts.locator(':scope > div').all()) {
    const label = (await row.locator('dt').boundingBox())!
    const value = (await row.locator('dd').first().boundingBox())!
    expect(Math.abs(value.y - label.y), 'on one line').toBeLessThan(4)
    expect(value.x).toBeGreaterThan(label.x + label.width)
  }
  for (const name of [t['common.refresh'], t['system.changeMode'], t['system.backupNow']]) {
    const h = (await page.getByRole('button', { name, exact: true }).first().boundingBox())!.height
    expect(Math.round(h), name).toBeGreaterThanOrEqual(44)
  }
})

test('Settings › Profile: the photo button and the language and theme choices are 44 px; username and role on the right', async ({ page }) => {
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-form')).toBeVisible()
  for (const id of ['profile-photo-pick', 'locale-team', 'locale-en']) expect(Math.round((await page.getByTestId(id).boundingBox())!.height), id).toBeGreaterThanOrEqual(44)
  const user = (await page.getByTestId('profile-username').boundingBox())!
  expect(user.x + user.width).toBeGreaterThan(390 - 30)
})

test('nothing on these pages is wider than the screen, in Spanish too', async ({ page }) => {
  await page.addInitScript(fakeDesktop)
  for (const locale of ['en', 'es'] as const) {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    const pages: [string, string][] = [
      ...['', ...GROUPS].map((g): [string, string] => [g ? `/admin/settings/${g}` : '/admin/settings', 'admin-content']),
      ['/admin/system', 'admin-content'],
      ...['profile', 'security', 'browser', 'memory', 'allowances', 'notifications', 'about'].map((s): [string, string] => [`/settings/${s}`, 'settings-content']),
    ]
    for (const [path, box] of pages) {
      await page.goto(path)
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expect(page.getByTestId(box)).toBeVisible()
      // drawn with its data, not its loading lines
      await expect(page.getByTestId(box).locator('.animate-pulse')).toHaveCount(0)
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${locale} ${path}`).toBeLessThanOrEqual(390)
      expect(await page.getByTestId(box).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${locale} ${path}`).toBe(true)
    }
  }
})

test.describe('a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
  test('one page as before; a group\'s address opens the page at that group', async ({ page }) => {
    await page.goto('/admin/settings')
    await expect(page.getByTestId('team-settings-list')).toHaveCount(0)
    for (const id of ['team-settings-general', 'team-settings-data', 'team-settings-ai', 'team-speech', 'engine-defaults', 'engine-budgets']) await expect(page.getByTestId(id)).toBeAttached()
    await page.goto('/admin/settings/voice')
    await expect(page).toHaveURL(/\/admin\/settings#speech$/)
    await expect(page.getByTestId('team-settings-general')).toBeAttached()
    await expect(page.getByTestId('team-speech')).toBeInViewport()
  })
})
