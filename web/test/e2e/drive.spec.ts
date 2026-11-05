// Google Drive in Settings › App connectors (components/integrations/DriveConnector.tsx DriveCard, pages/ConnectorConnections.tsx):
// a card whose Connect goes straight to Google, the account confirmation inside the card (a security step), then the
// account with ⋯ Reconnect / Disconnect; a server without a Google client; a Drive that needs a new sign-in; the old
// /settings/drive address; no guide text on the page; AI apps no longer on it; phone width and accessibility.
// Admin › App connectors: admin-app-connectors.spec.ts. AI apps: ai-apps.spec.ts.
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

const card = (page: Page) => page.getByTestId('app-connectors').getByTestId('drive-card')

test('Connect goes straight to Google; the card asks to confirm the account, then shows it with ⋯ Reconnect and Disconnect', async ({ page }) => {
  await reset(page)
  const state = await fakeDrive(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  const c = card(page)
  await expect(c).toContainText('Google Drive')
  await expect(c.getByTestId('drive-card-line')).toHaveText('내 Drive 파일을 찾고 읽어요')
  await expect(c.getByTestId('connector-logo')).toHaveAttribute('src', '/icons/connectors/google-drive.svg')
  // nothing else on the page: no guide, no AI apps, no code blocks
  await expect(page.getByTestId('ai-apps')).toHaveCount(0)
  await expect(page.locator('[data-testid="connector-connections"] code')).toHaveCount(0)

  const popup = page.waitForEvent('popup')
  await c.getByRole('button', { name: '연결', exact: true }).click()
  await popup
  expect(state.authorized).toBe(1)
  // back from Google: the same card asks to confirm the account (no Drive dialog over Settings)
  await expect(page.getByRole('dialog', { name: 'Google Drive' })).toHaveCount(0)
  await expect(c.getByTestId('drive-account')).toContainText('fixture@example.test')
  await expect(c.getByTestId('drive-confirm-step')).toContainText('이 계정을 연결할까요?')
  expect(state.completed).toBe(0)
  await c.getByRole('button', { name: '이 계정으로 연결 완료' }).click()

  await expect(c).toHaveAttribute('data-state', 'connected')
  await expect(c.getByTestId('drive-card-line')).toHaveText('fixture@example.test')
  await expect(c.getByTestId('drive-connected')).toHaveText('연결됨')
  expect(state.completed).toBe(1)

  // ⋯ › Disconnect: Google's revocation could not be done, and the person is told
  await c.getByTestId('drive-menu').click()
  await expect(c.getByRole('menuitem', { name: '다시 연결' })).toBeVisible()
  await c.getByRole('menuitem', { name: '연결 해제' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect(c).toHaveAttribute('data-state', 'disconnected')
  await expect(c.getByRole('button', { name: '연결', exact: true })).toBeVisible()
  await expect(page.getByTestId('drive-revoke-warning')).toContainText('Google 계정의 연결된 앱에서도')
  expect(state.disconnected).toBe(1)
  expect(realErrors(errors)).toEqual([])
})

test('Cancel while waiting for Google puts Connect back', async ({ page }) => {
  await reset(page)
  await fakeDrive(page)
  // Google has not sent the person back yet
  await page.unroute('**/api/integrations/google-drive/flows/**')
  await page.route('**/api/integrations/google-drive/flows/**', (r) => r.request().method() === 'DELETE'
    ? r.fulfill({ status: 204 })
    : r.fulfill({ json: { flowId: 'fixture-flow', state: 'pending', account: null, expiresAt, reason: null } }))
  await signIn(page)
  await page.goto('/settings/connectors')
  const c = card(page)
  const popup = page.waitForEvent('popup')
  await c.getByRole('button', { name: '연결', exact: true }).click()
  await popup
  await expect(c.getByTestId('drive-waiting')).toBeVisible()
  await c.getByTestId('drive-cancel').click()
  await expect(c.getByRole('button', { name: '연결', exact: true })).toBeVisible()
})

test('the old address and Settings search lead to App connectors; MCP has no Drive', async ({ page }) => {
  await reset(page)
  await fakeDrive(page)
  await signIn(page)
  await page.goto('/settings/drive')
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(card(page).getByRole('button', { name: '연결', exact: true })).toBeFocused()

  const settings = page.getByTestId('settings-dialog')
  await expect(settings.getByRole('link', { name: 'Google Drive', exact: true })).toHaveCount(0)
  await page.getByTestId('settings-search').fill('drive')
  await expect(settings.getByRole('link', { name: '앱 커넥터', exact: true })).toBeVisible()
  await expect(settings.getByRole('link', { name: 'MCP', exact: true })).toHaveCount(0)

  await page.goto('/settings/integrations')
  await page.getByTestId('connectors-header').getByRole('tab', { name: '둘러보기' }).click()
  await expect(page.getByTestId('connector-list')).toBeVisible()
  await expect(page.getByTestId('drive-card')).toHaveCount(0)
  await expect(page.getByText('Google Drive', { exact: true })).toHaveCount(0)
})

test('a server without a Google client: the card says "not available" with Connect turned off, for members and admins', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/connectors')
  await expect(card(page)).toHaveAttribute('data-state', 'disabled')
  await expect(card(page).getByTestId('drive-card-line')).toHaveText('아직 쓸 수 없어요')
  await expect(card(page).getByRole('button', { name: '연결', exact: true })).toBeDisabled()
  await expect(card(page).locator('a')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/settings/connectors')
  await expect(card(page).getByRole('button', { name: '연결', exact: true })).toBeDisabled()
  await expect(card(page).locator('a')).toHaveCount(0)
})

test('a Drive that needs a new sign-in says so on its card, with Reconnect', async ({ page }) => {
  await reset(page)
  const state = await fakeDrive(page, { ...connected, status: 'needs_reconnect' })
  await signIn(page)
  await page.goto('/settings/connectors')
  const c = card(page)
  await expect(c).toHaveAttribute('data-state', 'needs_reconnect')
  await expect(c.getByTestId('drive-card-line')).toHaveText('다시 연결 필요')
  const popup = page.waitForEvent('popup')
  await c.getByTestId('drive-reconnect').click()
  await popup
  await c.getByRole('button', { name: '이 계정으로 연결 완료' }).click()
  await expect(c).toHaveAttribute('data-state', 'connected')
  expect(state.completed).toBe(1)
})

test('phone width: the card fits without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await fakeDrive(page, connected)
  await signIn(page)
  await page.goto('/settings/connectors')
  await expect(card(page)).toHaveAttribute('data-state', 'connected')
  const box = await card(page).boundingBox()
  expect(box!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`App connectors, the confirm step and the ⋯ menu have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await fakeDrive(page)
    await signIn(page)
    await page.goto('/settings/connectors')
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    await expect(card(page)).toHaveAttribute('data-state', 'disconnected')
    expect(await audit()).toEqual([])
    const popup = page.waitForEvent('popup')
    await card(page).getByRole('button', { name: '연결', exact: true }).click()
    await popup
    await expect(card(page).getByTestId('drive-confirm-step')).toBeVisible()
    expect(await audit()).toEqual([])
    await card(page).getByRole('button', { name: '이 계정으로 연결 완료' }).click()
    await card(page).getByTestId('drive-menu').click()
    await expect(card(page).getByRole('menu')).toBeVisible()
    expect(await audit()).toEqual([])
  })
}
