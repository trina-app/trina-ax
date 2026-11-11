// Google Drive in Connectors (pages/Connectors.tsx, components/integrations/DriveConnector.tsx), Trina's own connector
// next to the Google apps and the MCP services: first in Popular, where its + goes straight to Google and its page
// (/connectors/google-drive) shows the steps; back from Google one inline line confirms the account (a security step);
// then it is among the connected apps on the page, and its page has the account, Try in chat and ⋯ Reconnect /
// Disconnect. Also: a server without a Google client, a Drive that needs a new sign-in, the old /settings/drive and
// /settings/integrations addresses, phone width and accessibility.
// Admin › Connectors' Drive page: admin-app-connectors.spec.ts. AI apps: ai-apps.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const disconnected = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
const account = { name: 'Drive Fixture', email: 'fixture@example.test' }
const connected = { ...disconnected, status: 'connected', account }
const expiresAt = '2099-01-01T00:00:00.000Z'

/** Answers the Drive addresses like a server with a Google client; `state.now` is what GET returns. */
async function fakeDrive(page: Page, start: object = disconnected) {
  const state = { now: start as object, authorized: 0, completed: 0, disconnected: 0 }
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.route('**/api/integrations/google-drive', (r) => {
    if (r.request().method() === 'DELETE') { state.disconnected++; state.now = disconnected; return r.fulfill({ json: { disconnected: true, revocation: 'unavailable' } }) }
    return r.fulfill({ json: state.now })
  })
  await page.route('**/api/integrations/google-drive/authorize', (r) => { state.authorized++; return r.fulfill({ json: { flowId: 'fixture-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } }) })
  await page.route('**/api/integrations/google-drive/flows/**', (r) => {
    if (r.request().method() === 'DELETE') return r.fulfill({ status: 204 })
    if (r.request().method() === 'POST') { state.completed++; state.now = connected; return r.fulfill({ json: connected }) }
    return r.fulfill({ json: { flowId: 'fixture-flow', state: 'ready', account, expiresAt, reason: null } })
  })
  return state
}

/** Popular is on the page under the connected apps: its heading is there */
const discover = (page: Page) => expect(page.getByTestId('connector-discover-title')).toBeVisible()
const driveCard = (page: Page) => page.locator('[data-testid="connector-card"][data-id="google-drive"]')
const detail = (page: Page) => page.getByTestId('drive-detail')
const icon = (page: Page) => page.locator('[data-testid="connected-app"][data-id="google-drive"]')

test('Popular lists Google Drive first; its + goes straight to Google, one line confirms the account, then it is among the connected apps', async ({ page }) => {
  await reset(page)
  const state = await fakeDrive(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/connectors')
  await expect(page.getByTestId('connectors-header').getByRole('heading', { name: '연결한 서비스', exact: true })).toBeVisible()
  await discover(page)
  await expect(page.getByTestId('connector-card').first()).toHaveAttribute('data-id', 'google-drive')
  await expect(driveCard(page)).toContainText('Drive 파일 찾고 읽기')
  await expect(driveCard(page).getByTestId('connector-logo')).toHaveAttribute('src', '/icons/connectors/google-drive.svg')

  const popup = page.waitForEvent('popup')
  await driveCard(page).getByTestId('connector-add').click()
  await popup
  expect(state.authorized).toBe(1)
  await expect(page).toHaveURL(/\/connectors\/google-drive$/)
  // its page shows the one step left: confirm the account Google sent back
  await expect(detail(page).getByTestId('drive-account')).toContainText('fixture@example.test')
  await expect(detail(page).getByTestId('drive-confirm-step')).toContainText('이 계정을 연결할까요?')
  await expect(detail(page).getByTestId('app-tool').first()).toHaveAttribute('data-name', 'drive_search')
  expect(state.completed).toBe(0)
  await detail(page).getByRole('button', { name: '이 계정으로 연결 완료' }).click()
  await expect(detail(page).getByTestId('drive-detail-line')).toHaveText('fixture@example.test')
  await expect(detail(page).getByTestId('drive-connected')).toHaveText('연결됨')
  await expect(detail(page).getByTestId('drive-try')).toBeVisible()
  expect(state.completed).toBe(1)

  // back on the list: among the connected apps, and its page has ⋯
  await page.getByTestId('app-breadcrumb-connectors').click()
  await icon(page).click()
  await expect(detail(page)).toHaveAttribute('data-state', 'connected')
  await detail(page).getByTestId('drive-menu').click()
  await expect(detail(page).getByRole('menuitem', { name: '다시 연결' })).toBeVisible()
  await detail(page).getByRole('menuitem', { name: '연결 해제' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '연결 해제', exact: true }).click()
  // Google's revocation could not be done, and the person is told on the page
  await expect(detail(page)).toHaveAttribute('data-state', 'disconnected')
  await expect(page.getByTestId('drive-revoke-warning')).toContainText('Google 계정의 연결된 앱에서도')
  expect(state.disconnected).toBe(1)
  // in Popular it is + again
  await page.getByTestId('app-breadcrumb-connectors').click()
  await expect(driveCard(page).getByTestId('connector-add')).toBeVisible()
  await expect(icon(page)).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('its page: Connect goes to Google, and Cancel while waiting puts Connect back', async ({ page }) => {
  await reset(page)
  await fakeDrive(page)
  // Google has not sent the person back yet
  await page.unroute('**/api/integrations/google-drive/flows/**')
  await page.route('**/api/integrations/google-drive/flows/**', (r) => r.request().method() === 'DELETE'
    ? r.fulfill({ status: 204 })
    : r.fulfill({ json: { flowId: 'fixture-flow', state: 'pending', account: null, expiresAt, reason: null } }))
  await signIn(page)
  await page.goto('/connectors')
  await discover(page)
  await driveCard(page).getByTestId('connector-open').click()
  await expect(detail(page)).toBeVisible()
  const popup = page.waitForEvent('popup')
  await detail(page).getByTestId('drive-connect').click()
  await popup
  await expect(detail(page).getByTestId('drive-waiting')).toBeVisible()
  await detail(page).getByTestId('drive-cancel').click()
  await expect(detail(page).getByTestId('drive-connect')).toBeVisible()
  await page.getByTestId('app-breadcrumb-connectors').click()
  await discover(page)
})

test('the old addresses lead to Connectors: /settings/drive opens Drive\'s page, /settings/integrations the list; Settings\' search finds it', async ({ page }) => {
  await reset(page)
  await fakeDrive(page)
  await signIn(page)
  await page.goto('/settings/drive')
  await expect(page).toHaveURL(/\/connectors\/google-drive$/)
  await expect(detail(page)).toBeVisible()

  await page.goto('/settings/profile')
  const settings = page.getByTestId('settings-dialog')
  await expect(settings.getByRole('link', { name: 'Google Drive', exact: true })).toHaveCount(0)
  await expect(settings.getByRole('link', { name: 'MCP', exact: true })).toHaveCount(0)
  await expect(settings.getByRole('link', { name: '앱 커넥터', exact: true })).toHaveCount(0)
  await page.getByTestId('settings-search').fill('drive')
  await expect(settings.getByRole('link', { name: '연결한 서비스', exact: true })).toBeVisible()

  await page.goto('/settings/integrations')
  await expect(page).toHaveURL(/\/connectors$/)
  await expect(page.getByTestId('connectors-header')).toBeVisible()
})

test('a server without a Google client: Drive is "not set up" in Popular and a member asks an admin to add it from its page', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/connectors')
  await discover(page)
  await expect(driveCard(page).getByTestId('connector-off')).toHaveText('아직 설정 안 됨')
  await expect(driveCard(page).getByTestId('connector-add')).toHaveCount(0)
  await driveCard(page).getByTestId('connector-open').click()
  // "Ask admin to add it" takes the place of the Connect that cannot work and of "관리자가 먼저 켜야 해요"
  await expect(detail(page).getByTestId('drive-connect')).toHaveCount(0)
  await expect(detail(page).getByTestId('drive-detail-line')).toHaveCount(0)
  await detail(page).getByTestId('service-ask').click()
  await expect(detail(page).getByTestId('service-asked')).toHaveAttribute('data-state', 'sent')
  await expect(detail(page).getByTestId('service-asked-note')).toHaveText('Google Drive 준비가 끝나면 알려 드릴게요.')
  await page.goto('/connectors')
  await expect(driveCard(page).getByTestId('connector-off')).toHaveText('요청 보냄')
})

test('a Drive that needs a new sign-in says so on the page, with Reconnect', async ({ page }) => {
  await reset(page)
  const state = await fakeDrive(page, { ...connected, status: 'needs_reconnect' })
  await signIn(page)
  await page.goto('/connectors')
  await expect(icon(page)).toHaveAttribute('data-warn', 'yes')
  await expect(driveCard(page).getByTestId('connector-reconnect')).toBeVisible()
  await icon(page).click()
  await expect(detail(page)).toHaveAttribute('data-state', 'needs_reconnect')
  await expect(detail(page).getByTestId('drive-detail-line')).toHaveText('다시 연결 필요')
  const popup = page.waitForEvent('popup')
  await detail(page).getByTestId('drive-reconnect').click()
  await popup
  await detail(page).getByRole('button', { name: '이 계정으로 연결 완료' }).click()
  await expect(detail(page)).toHaveAttribute('data-state', 'connected')
  expect(state.completed).toBe(1)
})

test('phone width: the connected apps, Popular and Drive\'s page fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await fakeDrive(page, connected)
  await signIn(page)
  await page.goto('/connectors')
  await expect(icon(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await discover(page)
  await driveCard(page).getByTestId('connector-open').click()
  await expect(detail(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Connectors' Popular, Drive's page with its confirm step and its ⋯ have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await fakeDrive(page)
    await signIn(page)
    await page.goto('/connectors')
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    await discover(page)
    await expect(driveCard(page)).toBeVisible()
    expect(await audit()).toEqual([])
    const popup = page.waitForEvent('popup')
    await driveCard(page).getByTestId('connector-add').click()
    await popup
    await expect(detail(page).getByTestId('drive-confirm-step')).toBeVisible()
    expect(await audit()).toEqual([])
    await detail(page).getByRole('button', { name: '이 계정으로 연결 완료' }).click()
    await detail(page).getByTestId('drive-menu').click()
    await expect(detail(page).getByRole('menu')).toBeVisible()
    expect(await audit()).toEqual([])
  })
}
