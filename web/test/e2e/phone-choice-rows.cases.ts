// QA TC-378 on a phone (390×844, touch), the row's steps as it says them: Admin › Team settings › General (language),
// AI engine (engine, model, answers at the same time, who picks), Voice input, Keeping data; Admin › Usage (Range,
// Group by); Me › Usage (Period). Expected: "Each setting is one row 'Name   value ›' (or a switch); a tap opens a
// bottom sheet with the choices (✓ on the current one) or a number sheet. No native select box, no ⌃⌄ number field, no
// two-option segmented box." So on each page: no select box in sight, each row shows its value, a tap opens the sheet
// with ✓ on the current choice, a pick saves as before (the page's Save, or at once) and Back closes the sheet, not
// the page. A computer keeps its select boxes (desktopCases). Each test runs in WebKit (the iPhone app's engine:
// phone-choice-rows.webkit.spec.ts) and Chromium (Android's: phone-choice-rows.spec.ts). SHOTS_DIR=<folder>: a
// screenshot of each page and sheet.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { openTab } from './nav'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.en

async function shot(page: Page, name: string, fullPage = false) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name), fullPage })
}

/** no select box in sight on the page (the filters inside a closed sheet are not in sight) */
async function noSelect(page: Page) {
  await expect(page.locator('select:visible')).toHaveCount(0)
}

/** the open sheet: a menu at the bottom of the screen, across it */
const sheet = (page: Page) => page.getByRole('menu')

/** taps the row `id`, checks the sheet's ✓ is on `current` (and only there), and returns the sheet */
async function openChoices(page: Page, id: string, current: string) {
  await page.getByTestId(id).click()
  const menu = sheet(page)
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  expect(box.x).toBeLessThanOrEqual(1)
  expect(box.width).toBeGreaterThanOrEqual(388)
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(844 - 2)
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveText(current)
  return menu
}

/** Back (the phone's swipe or Back button) closes the sheet and stays on the page */
async function backCloses(page: Page, id: string, current: string) {
  const url = page.url()
  await openChoices(page, id, current)
  await page.goBack()
  await expect(sheet(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
  await expect(page.getByTestId(id)).toBeVisible()
}

/** a phone's number field: the number keyboard, no ⌃⌄ arrows, at the row's end */
async function phoneNumber(field: Locator) {
  await expect(field).toHaveAttribute('inputmode', 'numeric')
  expect(await field.evaluate((el) => getComputedStyle(el).appearance)).toBe('textfield')
  const box = (await field.boundingBox())!
  expect(box.width).toBeLessThanOrEqual(80)
  expect(box.x).toBeGreaterThan(390 / 2)
}

async function openGroup(page: Page, id: string) {
  await page.goto(`/admin/settings/${id}`)
  await expect(page.getByTestId('team-settings').or(page.getByTestId('team-ai-settings')).first()).toBeVisible()
}

export function phoneCases() {
  // the app's service worker (WebKit) would answer the API itself, past page.route
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
  })

  test('TC-378 General: "Team default language  English ›" and the time zone are rows; a pick waits for Save', async ({ page }) => {
    // Admin › Team settings › General, as a person taps it
    await openTab(page, 'me')
    await page.getByTestId('settings-admin').click()
    await page.getByTestId('admin-row-settings').click()
    await page.getByTestId('team-settings-row-general').click()
    await expect(page).toHaveURL(/\/admin\/settings\/general$/)
    await expect(page.getByTestId('team-default-locale')).toBeVisible()
    await noSelect(page)
    await expect(page.getByTestId('team-default-locale')).toContainText(t['teamSettings.defaultLocale'])
    await expect(page.getByTestId('team-default-locale-value')).toHaveText('English')
    await expect(page.getByTestId('team-time-zone-value')).toHaveText('Seoul (UTC+9)')
    expect(Math.round((await page.getByTestId('team-default-locale').boundingBox())!.height)).toBeGreaterThanOrEqual(48)
    await shot(page, 'general.png')

    await backCloses(page, 'team-default-locale', 'English')
    const menu = await openChoices(page, 'team-default-locale', 'English')
    await expect(menu.getByRole('menuitemradio')).toHaveText(['English', '한국어', 'Bahasa Indonesia', '日本語', 'Español'])
    await shot(page, 'general-language-sheet.png')
    await page.getByTestId('team-default-locale-option-ja').click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.getByTestId('team-default-locale-value')).toHaveText('日本語')
    // the form's Save, as with the select
    const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
    await page.getByTestId('team-settings-savebar').getByRole('button', { name: t['common.save'] }).click()
    expect((await saved).postDataJSON()).toMatchObject({ defaultLocale: 'ja' })
    await page.reload()
    await expect(page.getByTestId('team-default-locale-value')).toHaveText('日本語')

    // the time zones (about 400): the sheet opens at the current one
    const zones = await openChoices(page, 'team-time-zone', 'ソウル (UTC+9)')
    await expect(zones.getByRole('menuitemradio', { checked: true })).toBeInViewport()
    await shot(page, 'general-time-zone-sheet.png')
    // city and offset, not the IANA name; the search narrows the sheet, the saved value stays the IANA name
    await expect(zones.getByRole('menuitemradio', { name: 'ソウル (UTC+9)', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('team-time-zone-search').fill('tokyo')
    const narrowed = await openChoices(page, 'team-time-zone', 'ソウル (UTC+9)')
    await expect(narrowed.getByRole('menuitemradio')).toHaveText(['ソウル (UTC+9)', '東京 (UTC+9)'])
    await narrowed.getByRole('menuitemradio', { name: '東京 (UTC+9)', exact: true }).click()
    await expect(page.getByTestId('team-time-zone-value')).toHaveText('東京 (UTC+9)')
    await expect(page.getByTestId('team-settings-savebar')).toBeVisible()
  })

  test('TC-378 AI engine: engine and model rows, the number without ⌃⌄, who picks as ✓ rows; each waits for its Save', async ({ page }) => {
    await openGroup(page, 'ai')
    await expect(page.getByTestId('ai-engine')).toBeVisible()
    await noSelect(page)
    await expect(page.getByTestId('ai-engine-value')).toHaveText('Claude')
    await expect(page.getByTestId('ai-model-value')).toHaveText(t['composer.defaultModel'])
    await phoneNumber(page.getByTestId('engines-concurrency'))
    // who picks: three ✓ rows across the screen, no segmented box
    const modes = page.getByTestId('engine-choice').getByRole('radio')
    await expect(modes).toHaveText([t['engines.choice.off'], t['engines.choice.everyone'], t['engines.choice.selected']])
    for (const r of await modes.all()) expect(Math.round((await r.boundingBox())!.height)).toBeGreaterThanOrEqual(48)
    await expect(page.getByTestId('engine-choice-off')).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'ai.png')

    await backCloses(page, 'ai-engine', 'Claude')
    const engines = await openChoices(page, 'ai-engine', 'Claude')
    await expect(engines.getByRole('menuitemradio')).toHaveText(['Claude', 'ChatGPT'])
    await shot(page, 'ai-engine-sheet.png')
    await page.goBack()
    const models = await openChoices(page, 'ai-model', t['composer.defaultModel'])
    await expect(models.getByRole('menuitemradio')).toHaveText([t['composer.defaultModel'], 'Sonnet', 'Opus'])
    await models.getByRole('menuitemradio', { name: 'Opus' }).click()
    await expect(page.getByTestId('ai-model-value')).toHaveText('Opus')
    const defaults = page.waitForRequest((r) => r.url().endsWith('/api/admin/engines') && r.method() !== 'GET')
    await page.getByTestId('engine-defaults-save').click()
    expect((await defaults).postDataJSON()).toMatchObject({ defaultEngine: 'claude-code', defaultModel: 'claude-opus' })
    await expect(page.getByTestId('engine-defaults-save')).toHaveCount(0)

    await page.getByTestId('engine-choice-everyone').click()
    await expect(page.getByTestId('engine-choice-everyone')).toHaveAttribute('aria-checked', 'true')
    const choice = page.waitForRequest((r) => r.url().endsWith('/api/admin/engines') && r.method() !== 'GET')
    await page.getByTestId('engine-choice-save').click()
    expect((await choice).postDataJSON()).toMatchObject({ memberChoice: { mode: 'everyone' } })
    await page.reload()
    await expect(page.getByTestId('ai-model-value')).toHaveText('Opus')
    await expect(page.getByTestId('engine-choice-everyone')).toHaveAttribute('aria-checked', 'true')
  })

  test('TC-378 Voice input: "Speech to text  On this server ›"; Off waits for Save', async ({ page }) => {
    await openGroup(page, 'voice')
    await expect(page.getByTestId('team-speech-provider')).toBeVisible()
    await noSelect(page)
    await expect(page.getByTestId('team-speech-provider-value')).toHaveText(t['speech.local'])
    await shot(page, 'voice.png')
    await backCloses(page, 'team-speech-provider', t['speech.local'])
    const menu = await openChoices(page, 'team-speech-provider', t['speech.local'])
    await expect(menu.getByRole('menuitemradio')).toHaveText([t['speech.off'], t['speech.openrouter'], t['speech.local']])
    await shot(page, 'voice-sheet.png')
    await page.getByTestId('team-speech-provider-option-off').click()
    await expect(page.getByTestId('team-speech-provider-value')).toHaveText(t['speech.off'])
    const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
    await page.getByTestId('team-settings-savebar').getByRole('button', { name: t['common.save'] }).click()
    expect((await saved).postDataJSON()).toMatchObject({ speechProvider: 'off' })
    await page.reload()
    await expect(page.getByTestId('team-speech-provider-value')).toHaveText(t['speech.off'])
  })

  test('TC-378 Keeping data: each period is a number field with "days" at the row\'s end, no ⌃⌄; a change waits for Save', async ({ page }) => {
    await openGroup(page, 'data')
    await noSelect(page)
    for (const id of ['ts-audit', 'ts-history', 'ts-trash', 'ts-chat-trash']) await phoneNumber(page.getByTestId(`${id}-days`))
    await expect(page.getByTestId('ts-audit-days')).toHaveValue('365')
    await shot(page, 'data.png')
    await page.getByTestId('ts-trash-days').fill('45')
    const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
    await page.getByTestId('team-settings-savebar').getByRole('button', { name: t['common.save'] }).click()
    expect((await saved).postDataJSON()).toMatchObject({ trashRetentionDays: 45 })
  })

  test('TC-378 Admin › Usage: "Range  Last 30 days ›" and Group by open a sheet; a pick changes the report at once', async ({ page }) => {
    await page.goto('/admin/usage')
    await expect(page.getByTestId('usage-rows')).toBeVisible()
    await noSelect(page)
    await expect(page.getByTestId('usage-range')).toContainText(t['usage.range.30d'])
    await expect(page.getByTestId('usage-groupby')).toContainText(t['usage.by.user'])
    await shot(page, 'usage.png')
    await backCloses(page, 'usage-range', t['usage.range.30d'])
    const range = await openChoices(page, 'usage-range', t['usage.range.30d'])
    await shot(page, 'usage-range-sheet.png')
    const week = page.waitForRequest((r) => r.url().includes('/api/admin/usage?'))
    await range.getByRole('menuitemradio', { name: t['usage.range.7d'] }).click()
    const q = new URL((await week).url()).searchParams
    expect((new Date(q.get('to')!).getTime() - new Date(q.get('from')!).getTime()) / 86_400_000).toBeCloseTo(7, 0)
    await expect(page.getByTestId('usage-range')).toContainText(t['usage.range.7d'])

    const group = await openChoices(page, 'usage-groupby', t['usage.by.user'])
    const byModel = page.waitForRequest((r) => r.url().includes('/api/admin/usage?') && r.url().includes('groupBy=model'))
    await group.getByRole('menuitemradio', { name: t['usage.by.model'] }).click()
    await byModel
    await expect(page.getByTestId('usage-groupby')).toContainText(t['usage.by.model'])
    await expect(page.getByTestId('usage-rows')).toContainText('model-test')
  })

  test('TC-378 Me › Usage: "Period  This month ›" opens a sheet; a pick changes the numbers at once', async ({ page }) => {
    await openTab(page, 'me')
    await page.getByTestId('settings-row-usage').click()
    await expect(page).toHaveURL(/\/settings\/usage$/)
    await expect(page.getByTestId('my-usage-period')).toBeVisible()
    await noSelect(page)
    await expect(page.getByTestId('my-usage-period')).toContainText(t['myUsage.period.month'])
    await shot(page, 'my-usage.png')
    await backCloses(page, 'my-usage-period', t['myUsage.period.month'])
    const menu = await openChoices(page, 'my-usage-period', t['myUsage.period.month'])
    await expect(menu.getByRole('menuitemradio')).toHaveText([t['myUsage.period.day'], t['myUsage.period.week'], t['myUsage.period.month']])
    await shot(page, 'my-usage-sheet.png')
    const week = page.waitForRequest((r) => r.url().includes('/api/me/usage?period=week'))
    await menu.getByRole('menuitemradio', { name: t['myUsage.period.week'] }).click()
    await week
    await expect(page.getByTestId('my-usage-period')).toContainText(t['myUsage.period.week'])
  })

  // not in the row's steps, the same pattern: Me › Profile's own default engine (people who may pick one)
  test('Me › Profile: "Engine  Team default (Claude) ›" and the model are list rows; a pick saves at once', async ({ page }) => {
    await page.goto('/settings/profile')
    await expect(page.getByTestId('my-engine-select')).toBeVisible()
    await noSelect(page)
    const team = translate('en', 'settings.myEngine.team', { engine: 'Claude' })
    await expect(page.getByTestId('my-engine-select-value')).toHaveText(team)
    await expect(page.getByTestId('my-model-select')).toHaveCount(0)
    await page.getByTestId('my-engine-select').scrollIntoViewIfNeeded()
    await shot(page, 'profile-engine.png')
    await backCloses(page, 'my-engine-select', team)
    const menu = await openChoices(page, 'my-engine-select', team)
    const saved = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/me\b/.test(r.url()))
    await menu.getByRole('menuitemradio', { name: 'ChatGPT', exact: true }).click()
    expect((await saved).postDataJSON()).toMatchObject({ prefs: { engine: 'codex' } })
    await expect(page.getByTestId('my-engine-select-value')).toHaveText('ChatGPT')
    // a screen reader or keyboard keeps its place: the pick gives the focus back to the row, not the page's top
    await expect(page.getByTestId('my-engine-select')).toBeFocused()
    await expect(page.getByTestId('my-model-select-value')).toHaveText(t['composer.defaultModel'])
  })
}

/** A computer (1440 wide) keeps its select boxes, segmented box and number fields as they were. */
export function desktopCases() {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US', serviceWorkers: 'block' })

  test('a computer keeps its select boxes on these pages', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/admin/settings')
    await expect(page.getByTestId('team-default-locale')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.getByTestId('team-time-zone')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.getByTestId('team-speech-provider')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.locator('#ai-engine')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.locator('#ai-model')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.getByTestId('engine-choice-everyone')).toHaveAttribute('role', 'radio')
    expect(await page.getByTestId('engines-concurrency').evaluate((el) => getComputedStyle(el).appearance)).not.toBe('textfield')
    await shot(page, 'desktop-team-settings.png', true)
    await page.goto('/admin/usage')
    await expect(page.getByTestId('usage-range')).toHaveJSProperty('tagName', 'SELECT')
    await expect(page.getByTestId('usage-groupby')).toHaveJSProperty('tagName', 'SELECT')
    await shot(page, 'desktop-usage.png', true)
    await page.goto('/settings/usage')
    await expect(page.getByTestId('my-usage-period')).toHaveJSProperty('tagName', 'SELECT')
    await shot(page, 'desktop-my-usage.png', true)
    await page.goto('/settings/profile')
    await expect(page.getByTestId('my-engine-select')).toHaveJSProperty('tagName', 'SELECT')
    await shot(page, 'desktop-profile.png', true)
  })
}
