// Settings › Connectors (pages/Connectors.tsx) and Gmail, Google Calendar, Google Docs and Google Sheets
// (components/integrations/GoogleAppConnector.tsx, GoogleAppAdmin.tsx; the mock: test/mock/googleApps.ts): Settings'
// section opens the list; Discover lists what can be added now first (Google Drive and the four apps once set up); Gmail's Connect opens Google, its page asks to
// confirm the account, then shows Connected and ⋯ (Settings, Reconnect, Disconnect); the old Settings › Connectors address leads to the page; Admin sets up
// a card with the same Google app as Drive; and an app that cannot be connected says why.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { openSettings, showChats } from './nav'

const BOB = { username: 'bob', password: 'bob password 1' }
const card = (page: Page, id: string) => page.locator(`[data-testid="connector-card"][data-id="${id}"]`)
const control = (page: Page, path: string, body: object) => page.request.post(path, { data: body })
const googleApps = (page: Page, body: object) => control(page, '/__test/google-apps', body)
const fakeGoogle = (page: Page) => page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))

test('Settings opens Connectors: Discover lists the Google ones first (QA TC-138, also not set up, with Set up); the search filters', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  // no sidebar item since 2026-11-12: the account menu's Settings, its Connectors section
  await expect(page.getByTestId('nav-connectors')).toHaveCount(0)
  await openSettings(page)
  await page.getByTestId('settings-menu').getByRole('link', { name: '커넥터', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(page.getByTestId('connectors-header').getByRole('heading', { name: '커넥터', exact: true })).toBeVisible()
  const ids = await page.getByTestId('connector-list').getByTestId('connector-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
  // the Google ones first, in their order, also when not set up yet; then the listed services
  expect(ids).toHaveLength(10)
  expect(ids.slice(0, 6)).toEqual(['google-drive', 'gmail', 'calendar', 'docs', 'sheets', 'notion'])
  await page.getByTestId('connector-show-all').click()
  await expect(page.getByTestId('connector-list').getByTestId('connector-card')).not.toHaveCount(10)
  // the owner gets the way to set them up instead of a +
  await expect(card(page, 'gmail').getByTestId('connector-set-up')).toHaveAttribute('href', '/admin/connectors')
  await expect(card(page, 'gmail').getByTestId('connector-add')).toHaveCount(0)
  await page.getByTestId('connector-search').fill('sheets')
  await expect(page.getByTestId('connector-list').getByTestId('connector-card')).toHaveCount(1)
  await expect(card(page, 'sheets')).toBeVisible()
  await page.getByTestId('connector-search').fill('nothing-like-this')
  await expect(page.getByText('"nothing-like-this"에 맞는 항목이 없어요.')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('Gmail: Connect opens Google, the account is confirmed, then Connected and ⋯ (Settings, Disconnect)', async ({ page }) => {
  await reset(page)
  await googleApps(page, { client: 'app' })
  await fakeGoogle(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/connectors')
  await card(page, 'gmail').getByTestId('connector-open').click()
  await expect(page).toHaveURL(/\/connectors\/gmail$/)
  const detail = page.getByTestId('gapp-detail')
  await expect(page.getByTestId('app-breadcrumb')).toContainText('커넥터')
  await expect(page.getByTestId('app-breadcrumb')).toContainText('Gmail')
  await expect(detail.getByTestId('app-by')).toContainText('Google')
  // every tool at once, as chips; one that changes things is marked
  await expect(detail.getByTestId('app-tools')).toBeVisible()
  await expect(detail.getByTestId('app-tool').filter({ has: page.getByTestId('app-tool-changes') })).not.toHaveCount(0)

  const popup = page.waitForEvent('popup')
  await detail.getByTestId('gapp-connect').click()
  await popup
  await expect(detail.getByTestId('gapp-account')).toContainText('olga@example.test')
  // the confirm step is waiting: a stray Esc or a click beside Settings does not close it (and lose the step)
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 450)
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(detail.getByTestId('gapp-confirm')).toBeVisible()
  await detail.getByTestId('gapp-confirm').click()
  await expect(detail).toHaveAttribute('data-state', 'connected')
  // done: Esc closes Settings again
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  await page.goto('/settings/connectors/gmail')
  await expect(detail.getByTestId('gapp-account-line')).toContainText('olga@example.test')
  for (const id of ['gapp-connected', 'gapp-menu']) await expect(detail.getByTestId(id)).toBeVisible()

  // ⋯ › Settings: Always allow, saved at once
  await detail.getByTestId('gapp-menu').click()
  await page.getByTestId('gapp-settings').click()
  const patched = page.waitForRequest((r) => /\/api\/integrations\/google-apps\/gmail$/.test(r.url()) && r.method() === 'PATCH')
  await page.getByTestId('gapp-policy-allow').check()
  expect((await patched).postDataJSON()).toEqual({ writePolicy: 'allow' })
  await expect(page.getByTestId('gapp-policy-allow')).toBeChecked()
  await page.getByTestId('gapp-settings-done').click()
  await expect(detail.getByTestId('app-abilities')).toContainText('항상 허용')

  // the list: Gmail in Your connectors, and no longer in Discover
  await page.getByTestId('app-breadcrumb-connectors').click()
  await expect(page.locator('[data-testid="connected-app"][data-id="gmail"]').getByTestId('connector-row-status')).toHaveText('연결됨')
  await expect(card(page, 'gmail')).toHaveCount(0)
  await page.locator('[data-testid="connected-app"][data-id="gmail"]').click()

  // ⋯ › Disconnect, confirmed
  await detail.getByTestId('gapp-menu').click()
  await page.getByTestId('gapp-menu-disconnect').click()
  await page.getByRole('dialog').getByRole('button', { name: '연결 해제' }).click()
  await expect(detail).toHaveAttribute('data-state', 'disconnected')
  await expect(detail.getByTestId('gapp-connect')).toBeEnabled()
  expect(realErrors(errors)).toEqual([])
})

test('Settings › Connectors is the Connectors page, with what its address asked for (also at its old addresses)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(page.getByTestId('settings-dialog').getByTestId('connector-discover')).toBeVisible()
  for (const add of ['/settings/connectors?add=1', '/connectors?add=1']) {
    await page.goto(add)
    await expect(page.getByRole('dialog', { name: '주소로 서비스 추가' })).toBeVisible()
    // the add dialog's Escape closes it, not Settings under it
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '주소로 서비스 추가' })).toHaveCount(0)
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
  }
  await page.goto('/settings/drive')
  await expect(page).toHaveURL(/\/settings\/connectors\/google-drive$/)
  await expect(page.getByTestId('drive-detail')).toBeVisible()
})

test('Admin sets up Gmail with the same Google app as Drive, per card; members can connect; the APIs to switch on are listed', async ({ page }) => {
  await reset(page)
  await control(page, '/__test/drive-client', {})
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  await expect(card(page, 'gmail')).toBeVisible()
  await card(page, 'gmail').getByTestId('connector-open').click()
  const detail = page.getByTestId('gapp-admin-detail')
  await expect(detail.getByTestId('gapp-admin-state')).toHaveAttribute('data-state', 'not_set_up')
  await expect(detail.getByTestId('gapp-admin-api')).toContainText('Gmail API')
  await detail.getByTestId('gapp-admin-setup').click()
  const dialog = page.getByTestId('gapp-setup-dialog')
  await expect(dialog.getByTestId('gapp-setup-same')).toBeChecked()
  await expect(dialog.getByTestId('drive-setup-id')).toHaveCount(0)
  // off: its own Google client, with the address to add in Google Cloud
  await dialog.getByTestId('gapp-setup-same').uncheck()
  await expect(dialog.getByTestId('drive-setup-redirect')).toContainText('/api/integrations/google-apps/callback')
  await expect(page.getByTestId('gapp-setup-save')).toBeDisabled()
  await dialog.getByTestId('gapp-setup-same').check()
  const put = page.waitForRequest((r) => /\/api\/admin\/google-apps\/gmail\/client$/.test(r.url()) && r.method() === 'PUT')
  await page.getByTestId('gapp-setup-save').click()
  expect((await put).postDataJSON()).toEqual({ sameAsDrive: true })
  await expect(detail.getByTestId('gapp-admin-state')).toHaveAttribute('data-state', 'on')
  await expect(detail.getByTestId('gapp-admin-same')).toBeVisible()
  // no members' switch: Team settings says who can use it
  await expect(detail.getByTestId('gapp-admin-members-switch')).toHaveCount(0)
  await expect(detail.getByTestId('team-who')).toBeVisible()
  // the other cards are their own: Calendar is still not set up
  await page.getByTestId('app-breadcrumb-connectors').click()
  await card(page, 'calendar').getByTestId('connector-open').click()
  await expect(page.getByTestId('gapp-admin-detail').getByTestId('gapp-admin-state')).toHaveAttribute('data-state', 'not_set_up')
  expect(realErrors(errors)).toEqual([])
})

test('without a Drive app the setup asks for this card\'s own Google client', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/connectors?app=sheets')
  await page.getByTestId('gapp-admin-setup').click()
  const dialog = page.getByTestId('gapp-setup-dialog')
  await expect(dialog.getByTestId('gapp-setup-same')).toHaveCount(0)
  await dialog.getByTestId('drive-setup-id').fill('id.apps.googleusercontent.com')
  await dialog.getByTestId('drive-setup-secret').fill('synthetic-secret')
  await page.getByTestId('gapp-setup-save').click()
  await expect(page.getByTestId('gapp-admin-state')).toHaveAttribute('data-state', 'on')
})

test('not available: the reason in plain words, Connect off; an admin gets the way to set it up', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  await page.goto('/connectors/gmail')
  const detail = page.getByTestId('gapp-detail')
  // not set up: a member asks an admin to add it (integrations.spec.ts), in place of the reason and the Connect
  await expect(detail.getByTestId('service-ask')).toHaveText('관리자에게 추가 요청하기')
  await expect(detail.getByTestId('gapp-unavailable')).toHaveCount(0)
  await expect(detail.getByTestId('gapp-admin-link')).toHaveCount(0)
  await expect(detail.getByTestId('gapp-connect')).toHaveCount(0)
  // set up: Connect at once (no members' switch, an old "members: false" changes nothing)
  await googleApps(page, { app: 'gmail', client: 'app', members: false })
  await page.reload()
  await expect(detail.getByTestId('gapp-connect')).toBeEnabled()
  await googleApps(page, { app: 'gmail', reason: 'unsupported' })
  await page.reload()
  await expect(detail.getByTestId('gapp-unavailable')).toHaveAttribute('data-reason', 'unsupported')
  await googleApps(page, { app: 'gmail', reason: 'service_limited' })
  // a member does not see a card that cannot be connected now
  await page.goto('/connectors')
  await expect(page.getByTestId('connector-discover')).toBeVisible()
  await expect(card(page, 'gmail')).toHaveCount(0)
  // a connected app whose tools cannot be reached right now: a calm note
  await googleApps(page, { app: 'docs', client: 'app', connect: { userId: 'bob', serviceDown: true } })
  await page.goto('/connectors/docs')
  await expect(page.getByTestId('gapp-service-down')).toBeVisible()

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/connectors/calendar')
  await page.getByTestId('gapp-admin-link').click()
  // the app's page in Admin › Connectors has an address of its own
  await expect(page).toHaveURL(/\/admin\/connectors\/calendar$/)
  await expect(page.getByTestId('gapp-admin-detail')).toContainText('Google Calendar')
})

test('phone width: the page and an app\'s page fit; Me has Connectors, the 트리나 list does not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await googleApps(page, { client: 'app' })
  await signIn(page)
  await showChats(page)
  await expect(page.locator('[data-testid="nav-connectors"]:visible')).toHaveCount(0)
  await page.goto('/settings')
  await page.getByTestId('settings-row-connectors').click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(page.getByTestId('settings-section-title')).toHaveText('커넥터')
  await expect(card(page, 'gmail')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.goto('/connectors/gmail')
  await expect(page.getByTestId('gapp-connect')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the page, Gmail's page and its Settings have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await googleApps(page, { client: 'app' })
    await googleApps(page, { app: 'gmail', connect: { userId: 'olga' } })
    await signIn(page)
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    await page.goto('/connectors')
    await expect(page.locator('[data-testid="connected-app"][data-id="gmail"]')).toBeVisible()
    await expect(card(page, 'calendar')).toBeVisible()
    expect(await audit()).toEqual([])
    await page.goto('/connectors/gmail')
    await expect(page.getByTestId('app-tools')).toBeVisible()
    expect(await audit()).toEqual([])
    await page.getByTestId('gapp-menu').click()
    await page.getByTestId('gapp-settings').click()
    expect(await audit()).toEqual([])
  })
}
