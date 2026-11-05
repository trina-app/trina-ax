// Google Drive in Settings › App connectors (components/integrations/DriveConnector.tsx, pages/ConnectorConnections.tsx):
// the first connector in the list, its connect dialog (explicit account confirmation, as before), its linked row, the
// old /settings/drive address, a server without a Google client, a Drive that needs a new sign-in, no Drive item in the
// Settings menu and none in MCP, phone width and accessibility. Admin › App connectors: admin-app-connectors.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const disconnected = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
const account = { name: 'Drive Fixture', email: 'fixture@example.test' }
const connected = { ...disconnected, status: 'connected', account }
const expiresAt = '2099-01-01T00:00:00.000Z'

/** Answers the Drive addresses like a server with a Google client; `state.now` is what GET returns. */
async function fakeDrive(page: Page, start: object = disconnected) {
  const state = { now: start as object, completed: 0, disconnected: 0 }
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.route('**/api/integrations/google-drive', (r) => {
    if (r.request().method() === 'DELETE') { state.disconnected++; state.now = disconnected; return r.fulfill({ json: { disconnected: true, revocation: 'unavailable' } }) }
    return r.fulfill({ json: state.now })
  })
  await page.route('**/api/integrations/google-drive/authorize', (r) => r.fulfill({ json: { flowId: 'fixture-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } }))
  await page.route('**/api/integrations/google-drive/flows/**', (r) => {
    if (r.request().method() === 'POST') { state.completed++; state.now = connected; return r.fulfill({ json: connected }) }
    return r.fulfill({ json: { flowId: 'fixture-flow', state: 'ready', account, expiresAt, reason: null } })
  })
  return state
}

const list = (page: Page) => page.getByTestId('app-connectors')

test('Drive is the first app connector: the dialog connects after an explicit account confirmation, then its row shows the account', async ({ page }) => {
  await reset(page)
  const state = await fakeDrive(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  const item = list(page).getByTestId('drive-item')
  await expect(item).toContainText('Google Drive')
  await expect(item.getByTestId('connector-logo')).toHaveAttribute('src', '/icons/connectors/google-drive.svg')
  // AI apps such as Claude come after it in the same list
  await expect(list(page).locator(':scope > li').nth(1)).toHaveAttribute('data-testid', 'ai-apps')
  await item.getByRole('button', { name: 'Google Drive 추가' }).click()

  const dialog = page.getByRole('dialog', { name: 'Google Drive' })
  await expect(dialog.getByTestId('drive-status')).toHaveText('연결되지 않음')
  await dialog.getByRole('button', { name: 'Google 계정 연결', exact: true }).click()
  await expect(page.getByTestId('drive-account')).toContainText('fixture@example.test')
  expect(state.completed).toBe(0)
  await dialog.getByRole('button', { name: '이 계정으로 연결 완료' }).click()

  // the dialog closes and the list shows the linked row
  await expect(dialog).toHaveCount(0)
  const row = list(page).getByTestId('drive-row')
  await expect(row).toContainText('fixture@example.test')
  expect(state.completed).toBe(1)

  // disconnect from the row: Google's revocation could not be done, and the person is told
  await row.getByTestId('drive-row-toggle').click()
  await row.getByRole('button', { name: '연결 해제', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect(list(page).getByTestId('drive-row')).toHaveCount(0)
  await expect(list(page).getByTestId('drive-item')).toBeVisible()
  await expect(page.getByTestId('drive-revoke-warning')).toContainText('Google 계정의 연결된 앱에서도')
  expect(state.disconnected).toBe(1)
  expect(realErrors(errors)).toEqual([])
})

test('no Drive item in the Settings menu or in MCP; the old address and Settings search lead to App connectors', async ({ page }) => {
  await reset(page)
  await fakeDrive(page)
  await signIn(page)
  await page.goto('/settings/drive')
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  const dialog = page.getByRole('dialog', { name: 'Google Drive' })
  await expect(dialog.getByTestId('drive-status')).toHaveText('연결되지 않음')
  await dialog.getByRole('button', { name: '닫기' }).click()
  await expect(dialog).toHaveCount(0)

  const settings = page.getByTestId('settings-dialog')
  await expect(settings.getByRole('link', { name: 'Google Drive', exact: true })).toHaveCount(0)
  await page.getByTestId('settings-search').fill('drive')
  await expect(settings.getByRole('link', { name: '앱 커넥터', exact: true })).toBeVisible()
  await expect(settings.getByRole('link', { name: 'MCP', exact: true })).toHaveCount(0)

  // MCP has no Drive card in Discover and no Drive row
  await page.goto('/settings/integrations')
  await page.getByTestId('connectors-header').getByRole('tab', { name: '둘러보기' }).click()
  await expect(page.getByTestId('connector-list')).toBeVisible()
  await expect(page.getByTestId('drive-item')).toHaveCount(0)
  await expect(page.getByText('Google Drive', { exact: true })).toHaveCount(0)
})

test('a server without a Google client: members see "not available", admins get the setup guide, no connect button', async ({ page }) => {
  await reset(page)
  // the test server itself answers "not configured"
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/connectors')
  const item = page.getByTestId('drive-item')
  await expect(item.getByTestId('drive-item-unavailable')).toHaveText('아직 쓸 수 없어요')
  await expect(item.getByRole('button')).toHaveCount(0)
  await expect(item.getByTestId('drive-setup-guide')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/settings/connectors')
  await expect(page.getByTestId('drive-setup-guide')).toHaveAttribute('href', /docs\/GOOGLE-DRIVE\.md$/)
  // the old address still opens the dialog, which explains the same
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-unavailable')).toContainText('관리자가 이 서버의 Google Drive 연결을 먼저 설정')
  await expect(page.getByRole('dialog', { name: 'Google Drive' }).getByRole('button', { name: 'Google 계정 연결' })).toHaveCount(0)
})

test('a Drive that needs a new sign-in says so on its row, with Reconnect beside it', async ({ page }) => {
  await reset(page)
  const state = await fakeDrive(page, { ...connected, status: 'needs_reconnect' })
  await signIn(page)
  await page.goto('/settings/connectors')
  const row = page.getByTestId('drive-row')
  await expect(row).toHaveAttribute('data-status', 'needs_reconnect')
  await expect(row).toContainText('다시 연결 필요')
  await row.getByTestId('drive-row-reconnect').click()
  await expect(page.getByTestId('drive-account')).toContainText('fixture@example.test')
  await row.getByRole('button', { name: '이 계정으로 연결 완료' }).click()
  await expect(row).toHaveAttribute('data-status', 'connected')
  expect(state.completed).toBe(1)
})

test('AI apps with no connected app: one quiet line, the address with Copy', async ({ page }) => {
  await reset(page)
  await page.route('**/api/connectors/remote', (r) => r.fulfill({ json: { configured: true, resource: 'https://team.example/mcp', items: [] } }))
  await signIn(page)
  await page.goto('/settings/connectors')
  const apps = page.getByTestId('ai-apps')
  await expect(apps.getByTestId('connector-address')).toContainText('https://team.example/mcp')
  await expect(apps.getByTestId('connectors-empty')).toHaveText('연결된 앱이 없어요.')
  await expect(page.locator('.border-dashed')).toHaveCount(0)
})

test('phone width: the list and the dialog fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await fakeDrive(page)
  await signIn(page)
  await page.goto('/settings/connectors?drive=1')
  const dialog = page.getByRole('dialog', { name: 'Google Drive' })
  await expect(dialog.getByTestId('drive-status')).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box!.width).toBeLessThanOrEqual(390)
  await dialog.getByRole('button', { name: '닫기' }).click()
  await expect(page.getByTestId('drive-item')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`App connectors and the Drive dialog have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await fakeDrive(page, connected)
    await signIn(page)
    await page.goto('/settings/connectors')
    await expect(page.getByTestId('drive-row')).toBeVisible()
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    expect(await audit()).toEqual([])
    await page.goto('/settings/connectors?drive=1')
    await expect(page.getByRole('dialog', { name: 'Google Drive' }).getByTestId('drive-status')).toHaveText('연결됨')
    expect(await audit()).toEqual([])
  })
}
