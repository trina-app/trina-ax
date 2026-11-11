// Settings on a phone at 390×844 (QA TC-261–263, docs/AGENTS/plan/20261111-1748-phone-settings-rows.md): sections are
// rows and switches, not a web page's buttons (Memory, Security & devices, Notifications, Profile, AI accounts, sign
// out); in the phone app what only works on a computer is not offered (connecting a service, AI app setup, Mac and
// Windows downloads); and there are no duplicate entries or loops (Activity, the AI's sites in one page, the "just for
// you" line, the schedule-review row). A computer keeps every section as it was.
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'
import { CSRF_HEADER } from '@mycel/shared/api'
import { WEB_ALLOW_ALL_WARNING_VERSION } from '@mycel/shared'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' } as const
const BOB = { username: 'bob', password: 'bob password 1' }
const box = async (l: Locator) => (await l.boundingBox())!
const tall = async (l: Locator, min = 44) => expect(Math.round((await box(l)).height)).toBeGreaterThanOrEqual(min)

/** Nothing scrolls sideways: the document and the open Settings section. */
async function fits(page: Page) {
  const over = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll<HTMLElement>('[data-testid="settings-content"]')].map((e) => e.scrollWidth - e.clientWidth))
  for (const d of over) expect(d).toBeLessThanOrEqual(0)
}

/** The phone app's bridge (mobile.spec.ts): every message answered ok. */
async function phoneApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void } }
    w.mycelMobile = { protocol: 1, appVersion: '0.4.0', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1'] }
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  })
}

/** Me (the 나 tab), then one of its rows */
async function me(page: Page, row?: string) {
  await page.goto('/')
  await page.getByTestId('tab-me').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  if (row) await page.getByTestId(row).click()
}

test.describe('TC-261: phone Settings sections use rows and switches, not web buttons (owner, 390)', () => {
  test.use(PHONE)
  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
  })

  test('1. Me › Memory: add, edit, delete one, forget everything — + in the bar, tap a row to edit, delete asks, Forget all a red row', async ({ page }) => {
    for (const text of ['Reports as a table', 'Meetings on Monday']) expect((await page.request.post('/__test/memory', { data: { text } })).ok()).toBe(true)
    await me(page, 'settings-row-memory')
    await expect(page).toHaveURL(/\/settings\/memory$/)
    const rows = page.getByTestId('memory-item')
    await expect(rows).toHaveCount(2)
    await fits(page)
    // add: the + in the bar
    const add = page.getByTestId('settings-bar-action').getByTestId('memory-add')
    await tall(add)
    await add.click()
    await page.getByTestId('memory-input').fill('Short answers')
    await page.getByTestId('memory-save').click()
    await expect(rows).toHaveCount(3)
    // edit: a tap on the row (no pencil or trash on a row)
    await expect(page.getByTestId('memory-edit')).toHaveCount(0)
    await tall(rows.first(), 48)
    await rows.filter({ hasText: 'Meetings on Monday' }).click()
    await expect(page.getByTestId('memory-sheet')).toBeVisible()
    await page.getByTestId('memory-input').fill('Meetings on Tuesday')
    await page.getByTestId('memory-save').click()
    await expect(rows.filter({ hasText: 'Meetings on Tuesday' })).toHaveCount(1)
    // delete one: it asks first; No keeps it
    await rows.filter({ hasText: 'Reports as a table' }).click()
    await page.getByTestId('memory-forget').click()
    await expect(page.getByTestId('dialog-confirm')).toBeVisible()
    await page.getByRole('button', { name: t['common.cancel'] }).last().click()
    await expect(rows).toHaveCount(3)
    await page.getByTestId('memory-forget').click()
    await page.getByTestId('dialog-confirm').click()
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'Reports as a table' })).toHaveCount(0)
    // forget everything: a red row of its own, which asks
    const clear = page.getByTestId('memory-clear')
    await tall(clear, 48)
    expect(await clear.locator('span.text-danger').count()).toBeGreaterThan(0)
    await clear.click()
    await page.getByTestId('dialog-confirm').click()
    await expect(rows).toHaveCount(0)
    await expect(page.getByText(t['memory.empty'])).toBeVisible()
  })

  test('2. Security & devices — devices and password are rows that open pages; no "Show 60 more" text button', async ({ page }) => {
    const ua = {
      mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    }
    const at = new Date().toISOString()
    const items = Array.from({ length: 64 }, (_, i) => ({ id: `0192f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`, client: 'web', userAgent: i === 1 ? ua.iphone : ua.mac, createdAt: at, lastSeenAt: at, expiresAt: at, current: i === 0 }))
    await page.route('**/api/me/sessions', (r) => r.fulfill({ json: { items } }))
    await me(page, 'settings-row-security')
    await expect(page.getByTestId('password-open')).toBeVisible()
    await tall(page.getByTestId('password-open'), 48)
    // no inline form and no "60 more" text button
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await expect(page.getByText(t['settings.devicesMore'].replace('{n}', '60'))).toHaveCount(0)
    await expect(page.getByTestId('device-row')).toHaveCount(1)
    await expect(page.getByTestId('device-row')).toContainText(t['settings.thisDevice'])
    await expect(page.getByTestId('devices-more')).toContainText('63')
    await fits(page)
    // the password page: its name in the bar, ‹ back to the section
    await page.getByTestId('password-open').click()
    await expect(page).toHaveURL(/\/settings\/security\/password$/)
    await expect(page.getByTestId('settings-section-title')).toHaveText(t['auth.changePassword'])
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/settings\/security$/)
    // every device on its own page; Safari on an iPhone has the phone icon
    await page.getByTestId('devices-more').click()
    await expect(page).toHaveURL(/\/settings\/security\/devices$/)
    await expect(page.getByTestId('settings-section-title')).toHaveText(t['settings.devices'])
    await expect(page.getByTestId('device-row')).toHaveCount(64)
    const iphone = page.getByTestId('device-row').nth(1)
    await expect(iphone).toContainText('iPhone')
    await expect(iphone.locator('svg.lucide-smartphone')).toHaveCount(1)
    await expect(page.getByTestId('device-row').nth(2).locator('svg.lucide-monitor')).toHaveCount(1)
    // a tap on another device asks before it is signed out
    let revoked = 0
    await page.route('**/api/me/sessions/*', (r) => { revoked++; return r.fulfill({ status: 204 }) })
    await iphone.click()
    await expect(page.getByTestId('dialog-confirm')).toBeVisible()
    await page.getByRole('button', { name: t['common.cancel'] }).last().click()
    expect(revoked).toBe(0)
  })

  test('3. Notifications › This device; message choice — push for this device a switch, all devices a red row that asks, checkmark rows', async ({ page }) => {
    const pushKey = 'B' + 'A'.repeat(86)
    let patched: unknown = null
    await page.route('**/api/push', (r) => {
      if (r.request().method() === 'PATCH') { patched = r.request().postDataJSON(); return r.fulfill({ json: { configured: true, enabled: false, publicKey: pushKey, subscriptionId: null } }) }
      return r.fulfill({ json: { configured: true, enabled: true, publicKey: pushKey, subscriptionId: null } })
    })
    await me(page, 'settings-row-notifications')
    await expect(page.getByTestId('notifications-rooms')).toBeVisible()
    await fits(page)
    // this device: a switch; every device: a red row that asks first
    await expect(page.getByTestId('push-here-switch')).toBeAttached()
    await expect(page.getByTestId('push-notifications')).not.toContainText(t['push.enable'])
    const everywhere = page.getByTestId('push-off-everywhere')
    await tall(everywhere, 48)
    expect(await everywhere.evaluate((el) => el.className)).toContain('text-danger')
    await everywhere.click()
    await expect(page.getByTestId('dialog-confirm')).toBeVisible()
    await page.getByRole('button', { name: t['common.cancel'] }).last().click()
    expect(patched).toBeNull()
    await everywhere.click()
    await page.getByTestId('dialog-confirm').click()
    await expect.poll(() => patched).toEqual({ enabled: false })
    // the message choice: rows with a checkmark, no radio circles
    const level = page.getByTestId('notification-room-level')
    await expect(level.locator('input[type="radio"]')).toHaveCount(0)
    const all = page.getByTestId('notification-room-level-all')
    await tall(all, 48)
    await all.click()
    await expect(all).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('notification-room-level-direct')).toHaveAttribute('aria-checked', 'false')
  })

  test('4. AI accounts — an Add account row', async ({ page }) => {
    await me(page, 'settings-row-providers')
    const addRow = page.getByTestId('my-credential-add-claude')
    await expect(addRow).toBeVisible()
    await tall(addRow, 48)
    // under the accounts, not a button beside the provider's name
    expect((await box(addRow)).y).toBeGreaterThan((await box(page.locator('#my-cred-claude'))).y + 20)
    expect(Math.round((await box(addRow)).width)).toBeGreaterThan(300)
    await addRow.click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('5. Profile — language and theme are checkmark lists', async ({ page }) => {
    await me(page, 'settings-me')
    await expect(page).toHaveURL(/\/settings\/profile$/)
    const english = page.getByTestId('locale-en')
    await expect(english).toHaveAttribute('role', 'radio')
    await expect(english).toHaveAttribute('aria-checked', 'false')
    await tall(english, 48)
    expect(await english.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    await expect(page.getByTestId('locale-team')).toHaveAttribute('aria-checked', 'true')
    const dark = page.getByTestId('theme-dark')
    await tall(dark, 48)
    await dark.click()
    await expect(dark).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'false')
    await fits(page)
  })

  test('6. Sign out — asks first', async ({ page }) => {
    await me(page)
    await page.getByTestId('settings-logout').click()
    await expect(page.getByTestId('dialog-confirm')).toBeVisible()
    await page.getByRole('button', { name: t['common.cancel'] }).last().click()
    await expect(page.getByTestId('settings-me')).toBeVisible()
    await page.getByTestId('settings-logout').click()
    await page.getByTestId('dialog-confirm').click()
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('TC-262: the phone app does not offer what only works on a computer (member)', () => {
  test.use(PHONE)
  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await phoneApp(page)
    // no share sheet here: the link is copied
    await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }) })
    await signIn(page, BOB)
  })

  test('1. Me › Connectors, tap + — one line "connect on a computer", no form, Save or Advanced', async ({ page }) => {
    await me(page, 'settings-row-connectors')
    await expect(page).toHaveURL(/\/connectors/)
    const card = page.locator('[data-testid="connector-card"][data-id="notion"]')
    await card.getByTestId('connector-add').click()
    await expect(page.getByTestId('integration-on-computer')).toBeVisible()
    await expect(page.getByTestId('integration-on-computer')).toContainText(t['integrations.onComputer'].replace('{name}', 'Notion'))
    await expect(page.getByTestId('integration-save')).toHaveCount(0)
    await expect(page.getByTestId('integration-advanced')).toHaveCount(0)
    await page.getByTestId('integration-on-computer-done').click()
    await expect(page.getByTestId('integration-on-computer')).toHaveCount(0)
  })

  test('2. Me › Use in other AI apps — connected apps only, plus "set up on a computer"', async ({ page }) => {
    await me(page, 'settings-row-ai-apps')
    await expect(page.getByTestId('ai-apps-on-computer')).toHaveText(t['aiApps.onComputer'])
    await expect(page.getByTestId('ai-app-list')).toHaveCount(0)
    await expect(page.getByTestId('connector-address')).toHaveCount(0)
    await expect(page.getByTestId('ai-app-dialog')).toHaveCount(0)
    await fits(page)
  })

  test('3. Me › Apps — a link to send to a computer instead of Mac/Windows downloads; no server terminal hint', async ({ page }) => {
    await me(page, 'settings-row-apps')
    const send = page.getByTestId('apps-send-to-computer')
    await expect(send).toBeVisible()
    await tall(send, 48)
    await expect(page.getByTestId('apps-computer')).toHaveCount(0)
    await expect(page.getByTestId('apps-owner-hint')).toHaveCount(0)
    await expect(page.getByText(/teamax|TeamAX/)).toHaveCount(0)
    await send.click()
    await expect(page.getByText(t['apps.linkCopied'])).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/settings\/apps$/)
  })
})

test.describe('TC-263: phone Settings has no duplicate entries or loops (owner, dev environment on)', () => {
  test.use(PHONE)
  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    expect((await page.request.post('/__test/dev-env', { data: { srt: true, sites: ['example.com'] } })).ok()).toBe(true)
    await signIn(page)
  })

  test('1. Me › Notifications — no "Open Activity" box', async ({ page }) => {
    await me(page, 'settings-row-notifications')
    await expect(page.getByTestId('notifications-rooms')).toBeVisible()
    await expect(page.getByTestId('notifications-activity')).toBeHidden()
    // and no "Just for you" line on the section (all of Me is just for you)
    await expect(page.getByTestId('page-scope')).toBeHidden()
  })

  test('2. Activity › ⚙ — no Notifications ↔ Activity loop; the unread count is not repeated there', async ({ page }) => {
    await me(page, 'settings-inbox')
    await expect(page).toHaveURL(/\/activity$/)
    const length = await page.evaluate(() => history.length)
    await page.getByTestId('activity-settings-phone').click()
    await expect(page).toHaveURL(/\/settings\/notifications$/)
    await expect(page.getByTestId('notifications-rooms')).toBeVisible()
    // no way back to Activity inside the settings (it led round in a loop), and so no second count
    await expect(page.getByRole('link', { name: t['inbox.open'] })).toBeHidden()
    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/activity$/)
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(length + 1)
  })

  test('4. Me list — Browser, Allowed for Trina and Dev environment sites are one page with three sections', async ({ page }) => {
    // Browser shows on a phone while the person's "Allow all websites" is on (#432)
    expect((await page.request.put('/api/me/web-access', { headers: { [CSRF_HEADER]: '1' }, data: { on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION } })).ok()).toBe(true)
    await me(page)
    await expect(page.getByTestId('settings-row-dev-env-sites')).toHaveCount(0)
    await expect(page.getByTestId('settings-row-browser')).toHaveCount(0)
    await page.getByTestId('settings-row-allowances').click()
    await expect(page.getByTestId('settings-section-title')).toHaveText(t['settings.allowances'])
    await expect(page.getByTestId('ai-allowances')).toBeVisible()
    await expect(page.getByTestId('allowances-part')).toBeVisible()
    await expect(page.locator('[data-testid="browser-settings"][data-part]')).toBeVisible()
    await expect(page.getByTestId('browser-all-switch')).toBeChecked()
    await expect(page.locator('[data-testid="dev-env-sites"][data-part]')).toBeVisible()
    await expect(page.getByTestId('dev-env-site')).toContainText('example.com')
    await tall(page.getByTestId('dev-env-site-remove'))
    expect(await page.getByTestId('dev-env-full').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    await fits(page)
    // the old addresses open the same page
    for (const old of ['/settings/dev-env-sites', '/settings/browser']) {
      await page.goto(old)
      await expect(page).toHaveURL(/\/settings\/allowances$/)
    }
  })

  test('the schedule-review banner on a Trina-tab page is one row', async ({ page }) => {
    expect((await page.request.post('/__test/schedule-review')).ok()).toBe(true)
    await page.goto('/activity')
    const row = page.getByTestId('schedule-review-row')
    await expect(row).toBeVisible()
    await tall(row)
    await expect(page.getByTestId('schedule-review-banner')).toBeHidden()
    await row.click()
    await expect(page).toHaveURL(/\/scheduled/)
  })
})

test.describe('a computer keeps every section as it was', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  test('Memory, Security, Notifications and Profile', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    expect((await page.request.post('/__test/memory', { data: { text: 'Reports as a table' } })).ok()).toBe(true)
    await page.goto('/settings/memory')
    await expect(page.getByTestId('memory-add')).toContainText(t['memory.add'])
    await expect(page.getByTestId('memory-edit')).toBeVisible()
    await expect(page.getByTestId('memory-forget')).toBeVisible()
    await expect(page.getByTestId('page-scope')).toBeVisible()
    await page.goto('/settings/security')
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
    await expect(page.getByTestId('password-open')).toHaveCount(0)
    await page.goto('/settings/notifications')
    await expect(page.getByTestId('notifications-activity')).toBeVisible()
    await expect(page.getByTestId('notification-room-level').locator('input[type="radio"]')).toHaveCount(3)
    await page.goto('/settings/profile')
    await expect(page.getByTestId('locale-en')).toHaveAttribute('role', 'radio')
    expect(await page.getByTestId('locale-en').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')
    await expect(page.getByTestId('theme-dark')).toHaveCount(0)
  })
})
