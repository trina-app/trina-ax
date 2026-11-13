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

test('phone width: the ⋯ menu on a person\'s connected Gmail page opens fully on screen (QA TC-935)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await googleApps(page, { client: 'app' })
  await fakeGoogle(page)
  await signIn(page)
  await page.goto('/settings/connectors/gmail')
  const detail = page.getByTestId('gapp-detail')
  const popup = page.waitForEvent('popup')
  await detail.getByTestId('gapp-connect').click()
  await popup
  await detail.getByTestId('gapp-confirm').click()
  await expect(detail).toHaveAttribute('data-state', 'connected')
  await detail.getByTestId('gapp-menu').click()
  const menu = page.getByTestId('gapp-menu-items')
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 8)
  await expect(page.getByTestId('gapp-menu-disconnect')).toBeInViewport({ ratio: 1 })
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

test('Admin shares one Gmail account with the team (QA TC-198): sign in, confirm, pick who uses it; Change people, Remove', async ({ page }) => {
  await reset(page)
  await googleApps(page, { app: 'gmail', client: 'app' })
  await fakeGoogle(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/connectors?app=gmail')
  const row = page.getByTestId('gapp-team')
  await expect(row.getByTestId('gapp-team-row')).toContainText('팀이 함께 쓰는 Google 계정')
  const popup = page.waitForEvent('popup')
  await row.getByTestId('gapp-team-connect').click()
  const dialog = page.getByTestId('gapp-team-dialog')
  await expect(dialog).toHaveAttribute('data-step', 'connect')
  await dialog.getByTestId('gapp-team-google').click()
  await popup
  await expect(dialog.getByTestId('gapp-team-account')).toContainText('team-gmail@example.test')
  await dialog.getByTestId('gapp-team-confirm').click()
  // then who may use it: nobody until Save
  await expect(dialog).toHaveAttribute('data-step', 'people')
  await expect(dialog.getByTestId('gapp-team-signed-in')).toContainText('team-gmail@example.test')
  await expect(dialog.getByTestId('integration-access-pick')).toBeChecked()
  await dialog.getByTestId('integration-access-everyone').check()
  const put = page.waitForRequest((r) => /\/api\/admin\/google-apps\/gmail\/team$/.test(r.url()) && r.method() === 'PUT')
  await page.getByTestId('gapp-team-save').click()
  expect((await put).postDataJSON()).toEqual({ access: { everyone: true, groups: [], users: [] } })
  await expect(row.getByTestId('gapp-team-email')).toHaveText('team-gmail@example.test')
  await expect(row.getByTestId('gapp-team-detail')).not.toContainText('아무도')
  await expect(row.getByTestId('gapp-team-connect')).toHaveCount(0)
  // ⋯ › Remove, confirmed: back to Connect for the team
  await row.getByTestId('gapp-team-menu').click()
  await page.getByTestId('gapp-team-remove').click()
  await page.getByRole('dialog').getByRole('button', { name: '없애기' }).click()
  await expect(row.getByTestId('gapp-team-connect')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('a member sees the shared account when it includes them, and has no way to make or change one', async ({ page }) => {
  await reset(page)
  await googleApps(page, { app: 'gmail', client: 'app', team: { email: 'team-box@example.test', access: { everyone: false, groups: [], users: ['bob'] } } })
  await signIn(page, BOB)
  await page.goto('/connectors/gmail')
  const detail = page.getByTestId('gapp-detail')
  await expect(detail.getByTestId('gapp-shared')).toContainText('team-box@example.test')
  // their own Connect stays
  await expect(detail.getByTestId('gapp-connect')).toBeEnabled()
  await expect(page.getByTestId('gapp-team-connect')).toHaveCount(0)
  // not included: nothing about it
  await googleApps(page, { app: 'gmail', team: { email: 'team-box@example.test', access: { everyone: false, groups: [], users: [] } } })
  await page.reload()
  await expect(detail.getByTestId('gapp-connect')).toBeEnabled()
  await expect(detail.getByTestId('gapp-shared')).toHaveCount(0)
  // the admin page is not theirs
  const r = await page.request.post('/api/admin/google-apps/gmail/team/authorize', { data: {} })
  expect(r.status()).toBe(403)
})

// The company's own Google app (components/integrations/GoogleSignInRow.tsx; docs/site/use/google-own-app.md): one row
// first in Team settings on all five Google pages, where the hosting service is the Google sign-in (the mock: POST
// /__test/google-own-app {hosted}). Set from one page, the others show it; going back asks first with the same numbers.
const ownApp = (page: Page, body: object) => control(page, '/__test/google-own-app', body)
const DRIVE_BACK = 'https://acme.example.com/api/integrations/google-drive/callback'
const APPS_BACK = 'https://acme.example.com/api/integrations/google-apps/callback'
const googleFile = (uris: string[]) => ({ name: 'client_secret_acme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ web: { client_id: '123-acme.apps.googleusercontent.com', client_secret: 'synthetic-secret', redirect_uris: uris } })) })

test('Admin sets the company\'s own Google app from Gmail\'s page, sees it on Drive\'s page, then goes back to Trina\'s sign-in', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await googleApps(page, { app: 'gmail', client: 'app' })
  await signIn(page)
  // a server the hosting service does not serve: no row, the per-card setup as before
  await page.goto('/admin/connectors/gmail')
  await expect(page.getByTestId('gapp-admin-detail')).toBeVisible()
  await expect(page.getByTestId('gsign-row')).toHaveCount(0)

  await ownApp(page, { hosted: true })
  await googleApps(page, { app: 'gmail', connect: { userId: 'bob', email: 'bob@acme.example.com' } })
  await page.reload()
  const row = page.getByTestId('gsign-row')
  await expect(row).toHaveAttribute('data-state', 'trina')
  // first in Team settings, and the hosting service's line above is gone (the row says it)
  const first = await page.getByTestId('team-settings').locator('[data-testid$="-row"], [data-testid="team-who"]').first().getAttribute('data-testid')
  expect(first).toBe('gsign-row')
  await expect(page.getByTestId('gapp-by-service')).toHaveCount(0)

  await row.getByTestId('gsign-use').click()
  const dialog = page.getByTestId('gsign-dialog')
  await expect(dialog).toHaveAttribute('data-step', 'start')
  await expect(dialog.getByTestId('gsign-guide')).toHaveAttribute('href', 'https://ax.trina.app/docs/use/google-own-app/')
  await page.getByTestId('gsign-next').click()
  await expect(dialog).toHaveAttribute('data-step', 'cloud')
  await expect(dialog.getByTestId('drive-setup-step')).toHaveCount(6)
  await expect(dialog.getByTestId('gsign-address-drive')).toHaveText(DRIVE_BACK)
  await expect(dialog.getByTestId('gsign-address-apps')).toHaveText(APPS_BACK)
  await page.getByTestId('gsign-next').click()
  await expect(dialog).toHaveAttribute('data-step', 'add')
  await expect(page.getByTestId('gsign-next')).toBeDisabled()
  // a file without the apps' return address: refused here, with the address to add
  await dialog.getByTestId('drive-setup-file').setInputFiles(googleFile([DRIVE_BACK]))
  await page.getByTestId('gsign-next').click()
  await expect(dialog.getByTestId('gsign-error')).toContainText(APPS_BACK)
  await expect(dialog).toHaveAttribute('data-step', 'add')
  await dialog.getByTestId('drive-setup-file').setInputFiles(googleFile([DRIVE_BACK, APPS_BACK]))
  await expect(dialog.getByTestId('gsign-error')).toHaveCount(0)
  // nothing is sent before Save
  let sent = 0
  page.on('request', (r) => { if (/\/api\/admin\/google\/own-app$/.test(r.url()) && r.method() !== 'GET') sent++ })
  await page.getByTestId('gsign-next').click()
  await expect(dialog).toHaveAttribute('data-step', 'confirm')
  await expect(dialog.getByTestId('gsign-people')).toContainText('1')
  // Back and forward again keep the file
  await page.getByTestId('gsign-back').click()
  await expect(dialog.getByTestId('drive-setup-upload')).toContainText('client_secret_acme.json')
  await page.getByTestId('gsign-next').click()
  expect(sent).toBe(0)
  const put = page.waitForRequest((r) => /\/api\/admin\/google\/own-app$/.test(r.url()) && r.method() === 'PUT')
  await page.getByTestId('gsign-save').click()
  expect((await put).postDataJSON()).toEqual({ file: (googleFile([DRIVE_BACK, APPS_BACK]).buffer).toString() })
  await expect(dialog).toHaveCount(0)
  await expect(row).toHaveAttribute('data-state', 'company')
  await expect(row).toContainText('Olga')

  // Drive's page: the same row, set
  await page.goto('/admin/connectors/google-drive')
  await expect(page.getByTestId('gsign-row')).toHaveAttribute('data-state', 'company')
  await expect(page.getByTestId('drive-by-service')).toHaveCount(0)
  await expect(page.getByTestId('drive-by-server')).toHaveCount(0)

  // back to Trina's: asks first with the numbers, then all five follow
  await page.getByTestId('gsign-menu').click()
  await page.getByTestId('gsign-remove').click()
  await expect(page.getByTestId('gsign-remove-body')).toBeVisible()
  const del = page.waitForRequest((r) => /\/api\/admin\/google\/own-app$/.test(r.url()) && r.method() === 'DELETE')
  await page.getByTestId('dialog-confirm').click()
  await del
  await expect(page.getByTestId('gsign-row')).toHaveAttribute('data-state', 'trina')
  await page.goto('/admin/connectors/gmail')
  await expect(page.getByTestId('gsign-row')).toHaveAttribute('data-state', 'trina')
  expect(realErrors(errors)).toEqual([])
})

test('the company\'s app: Esc closes the dialog unsaved; without Trina\'s sign-in behind it, removing says Google turns off', async ({ page }) => {
  await reset(page)
  await ownApp(page, { hosted: true, active: true, canGoBack: false, by: { id: 'olga', name: 'Olga' } })
  await signIn(page)
  await page.goto('/admin/connectors/calendar')
  await page.getByTestId('gsign-menu').click()
  await page.getByTestId('gsign-replace').click()
  // Replace starts at the file
  await expect(page.getByTestId('gsign-dialog')).toHaveAttribute('data-step', 'add')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('gsign-dialog')).toHaveCount(0)
  await expect(page.getByTestId('gsign-stale')).toHaveCount(0)
  await page.getByTestId('gsign-menu').click()
  const item = page.getByTestId('gsign-remove')
  await expect(item).toHaveClass(/text-danger/)
  await item.click()
  await expect(page.getByTestId('gsign-remove-body')).toBeVisible()
  await expect(page.getByTestId('gsign-people')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('gsign-row')).toHaveAttribute('data-state', 'company')
})

test('a member sees no Google sign-in row; after the switch their Gmail asks to connect again', async ({ page }) => {
  await reset(page)
  await ownApp(page, { hosted: true })
  await googleApps(page, { app: 'gmail', connect: { userId: 'bob', email: 'bob@acme.example.com' } })
  await signIn(page)
  await page.goto('/admin/connectors/gmail')
  await page.getByTestId('gsign-use').click()
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('drive-setup-manual').click()
  await page.getByTestId('drive-setup-id').fill('123-acme.apps.googleusercontent.com')
  await page.getByTestId('drive-setup-secret').fill('synthetic-secret')
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('gsign-save').click()
  await expect(page.getByTestId('gsign-row')).toHaveAttribute('data-state', 'company')

  await page.context().clearCookies()
  await signIn(page, BOB)
  // the page the row is on (Admin › Connectors › Gmail) is not theirs: no row there, only the admins-only page
  await page.goto('/admin/connectors/gmail')
  await expect(page.getByTestId('admin-only')).toBeVisible()
  await expect(page.getByTestId('gsign-row')).toHaveCount(0)
  await expect(page.getByTestId('gapp-admin-detail')).toHaveCount(0)
  // their own Gmail page: their usual Reconnect, and no row either
  await page.goto('/connectors/gmail')
  const detail = page.getByTestId('gapp-detail')
  await expect(detail.getByTestId('gapp-reconnect')).toBeVisible()
  await expect(page.getByTestId('gsign-row')).toHaveCount(0)
  // the setting is not theirs
  expect((await page.request.get('/api/admin/google/own-app')).status()).toBe(403)
})

test('the team\'s address changed after the company\'s app was set: the row says so, and Replace opens at the new return addresses', async ({ page }) => {
  await reset(page)
  await ownApp(page, { hosted: true, active: true, stale: true, by: { id: 'olga', name: 'Olga' } })
  await signIn(page)
  await page.goto('/admin/connectors/sheets')
  await expect(page.getByTestId('gsign-row')).toHaveAttribute('data-state', 'company')
  await expect(page.getByTestId('gsign-stale')).toBeVisible()
  await page.getByTestId('gsign-menu').click()
  await page.getByTestId('gsign-replace').click()
  const dialog = page.getByTestId('gsign-dialog')
  await expect(dialog).toHaveAttribute('data-step', 'cloud')
  await expect(dialog.getByTestId('gsign-address-drive')).toHaveText(DRIVE_BACK)
  await expect(dialog.getByTestId('gsign-address-apps')).toHaveText(APPS_BACK)
  // then the new file, and Save: no longer stale
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('drive-setup-file').setInputFiles(googleFile([DRIVE_BACK, APPS_BACK]))
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('gsign-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('gsign-stale')).toHaveCount(0)
})

test('Trina\'s own client file is not taken in the dialog: it asks for Google\'s file or the ID and secret', async ({ page }) => {
  await reset(page)
  await ownApp(page, { hosted: true })
  await signIn(page)
  await page.goto('/admin/connectors/gmail')
  await page.getByTestId('gsign-use').click()
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('gsign-next').click()
  await page.getByTestId('drive-setup-file').setInputFiles({ name: 'client.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ clientId: '123-acme.apps.googleusercontent.com', clientSecret: 'synthetic-secret', redirectUri: DRIVE_BACK })) })
  await page.getByTestId('gsign-next').click()
  await expect(page.getByTestId('gsign-error')).toContainText('Download JSON')
  await expect(page.getByTestId('gsign-dialog')).toHaveAttribute('data-step', 'add')
})
