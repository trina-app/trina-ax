// Admin › Connectors' Google Drive (pages/admin/Integrations.tsx, DriveConnector.tsx DriveAdminDetail): first in Discover;
// its page says on or not and how many members are connected, with "Set up Google once": a small dialog takes the Google
// OAuth client file (or its ID and secret), after which members can Connect. No setup guide or code. A client the
// operator set, a hosted server or one without a public address: one line instead of Set up. The old
// /admin/app-connectors opens this page. AI apps are their own page: ai-apps.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const REDIRECT = 'https://team.example.test/api/integrations/google-drive/callback'
const webClient = (uris = [REDIRECT]) => JSON.stringify({ web: { client_id: 'synthetic.apps.googleusercontent.com', client_secret: 'synthetic-secret', redirect_uris: uris } })
const card = (page: Page) => page.getByTestId('drive-admin-detail')
const openDrive = async (page: Page) => { await page.goto('/admin/app-connectors'); await expect(card(page)).toBeVisible() }

async function upload(page: Page, text: string) {
  await page.getByTestId('drive-setup-file').setInputFiles({ name: 'client_secret.json', mimeType: 'application/json', buffer: Buffer.from(text) })
}

test('Connectors is in the Admin menu; Drive not set up yet: Set up takes the client file, then members can Connect', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin')
  const menu = page.getByTestId('admin-menu')
  await expect(menu.getByRole('link', { name: 'MCP', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('link', { name: '앱 커넥터', exact: true })).toHaveCount(0)
  await menu.getByRole('link', { name: '커넥터', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  // Discover is on the same page, under the team's connections (none yet)
  await expect(page.getByTestId('connector-discover-title')).toHaveText('둘러보기')
  const drive = page.locator('[data-testid="connector-card"][data-id="google-drive"]')
  await expect(page.getByTestId('connector-card').first()).toHaveAttribute('data-id', 'google-drive')
  // + on a Drive that is not set up opens its page with the one-time setup
  await drive.getByTestId('connector-add').click()
  await expect(card(page)).toContainText('설정 안 됨')
  // no guide, no code blocks, no AI apps on this page
  await expect(page.locator('main code, main pre')).toHaveCount(0)
  await expect(page.getByTestId('admin-ai-apps')).toHaveCount(0)

  // a file without this server's redirect URI is refused, and says why
  const dialog = page.getByRole('dialog', { name: 'Google Drive 설정' })
  await expect(dialog.getByTestId('drive-setup-redirect')).toHaveText(REDIRECT)
  await upload(page, webClient(['https://other.example/cb']))
  await dialog.getByTestId('drive-setup-save').click()
  await expect(dialog.getByTestId('drive-setup-error')).toContainText('리디렉션 URI')
  // from here on nothing fails (the refused file above answered 400 on purpose)
  const errors = watchConsole(page)
  await upload(page, webClient())
  await dialog.getByTestId('drive-setup-save').click()
  await expect(dialog).toHaveCount(0)
  // a Google client only makes Drive available: nothing is on yet
  await expect(card(page).getByTestId('drive-admin-state')).toHaveText('설정 대기')
  await expect(card(page).getByTestId('drive-setup')).toHaveText('바꾸기')
  await expect(card(page).getByTestId('drive-members-switch')).not.toBeChecked()
  expect(realErrors(errors)).toEqual([])

  // a member cannot connect their own yet
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-connect')).toBeDisabled()
  await expect(page.getByTestId('drive-detail-line')).toHaveText('관리자가 먼저 켜야 해요')

  // the admin's switch turns it on
  await page.context().clearCookies()
  await signIn(page)
  await openDrive(page)
  await card(page).getByTestId('drive-members-switch').check({ force: true })
  await expect(card(page).getByTestId('drive-admin-state')).toHaveText('켜짐')
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-connect')).toBeEnabled()
})

test('the client ID and secret work too; Save waits until both are there', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await openDrive(page)
  await card(page).getByTestId('drive-setup').click()
  const dialog = page.getByRole('dialog', { name: 'Google Drive 설정' })
  await expect(dialog.getByTestId('drive-setup-save')).toBeDisabled()
  await dialog.getByTestId('drive-setup-id').fill('synthetic.apps.googleusercontent.com')
  await expect(dialog.getByTestId('drive-setup-save')).toBeDisabled()
  await dialog.getByTestId('drive-setup-secret').fill('synthetic-secret')
  await dialog.getByTestId('drive-setup-save').click()
  await expect(card(page).getByTestId('drive-admin-state')).toHaveText('설정 대기')
})

test('where this page may not set it up: one line instead of Set up', async ({ page }) => {
  await reset(page)
  await page.route('**/api/admin/google-drive', (r) => r.fulfill({ json: { configured: true, source: 'server', canSetUp: false, blocked: 'server', redirectUri: REDIRECT, connectedMembers: 3 } }))
  await signIn(page)
  await openDrive(page)
  await expect(card(page)).toContainText('멤버 3명 연결됨')
  await expect(card(page).getByTestId('drive-by-server')).toBeVisible()
  await expect(card(page).getByTestId('drive-setup')).toHaveCount(0)

  await page.unroute('**/api/admin/google-drive')
  await page.route('**/api/admin/google-drive', (r) => r.fulfill({ json: { configured: false, source: 'none', canSetUp: false, blocked: 'public_host', redirectUri: null, connectedMembers: 0 } }))
  await openDrive(page)
  await expect(card(page).getByTestId('drive-admin-detail-line')).toHaveText('먼저 이 서버의 공개 주소가 필요해요.')
  await expect(card(page).getByTestId('drive-setup')).toHaveCount(0)
})

test('members cannot open Admin › Connectors', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/connectors')
  await expect(page).not.toHaveURL(/\/admin/)
})

test('phone width: the card and the dialog fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await openDrive(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await card(page).getByTestId('drive-setup').click()
  const box = await page.getByRole('dialog').boundingBox()
  expect(box!.width).toBeLessThanOrEqual(390)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Admin › Connectors' Drive page and the Set up dialog have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await openDrive(page)
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    expect(await audit()).toEqual([])
    await card(page).getByTestId('drive-setup').click()
    await expect(page.getByRole('dialog').getByTestId('drive-setup-redirect')).toBeVisible()
    expect(await audit()).toEqual([])
  })
}
