// Admin › App connectors (pages/admin/AppConnectors.tsx): in the "Shared with the team" group, one row per connector with
// its state (set in the server setup, so no switch), what members see, the connector address and the setup guides.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function serverOffers(page: Page, o: { drive: boolean; connector: boolean }) {
  await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: { configured: o.drive, status: o.drive ? 'disconnected' : 'disabled', account: null, scopes: [], expiresAt: null } }))
  await page.route('**/api/connectors/remote', (r) => r.fulfill({ json: { configured: o.connector, resource: o.connector ? 'https://team.example/mcp' : null, items: [] } }))
}

test('the Admin menu has App connectors under Shared with the team; a server without either shows both as not set up, with the guides', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin')
  await page.getByTestId('admin-menu').getByRole('group', { name: '팀 공용' }).getByRole('link', { name: '앱 커넥터' }).click()
  await expect(page).toHaveURL(/\/admin\/app-connectors$/)
  await expect(page.getByTestId('app-connectors-header')).toContainText('앱 커넥터')
  const drive = page.getByTestId('admin-drive')
  await expect(drive).toHaveAttribute('data-on', 'false')
  await expect(drive).toContainText('설정 안 됨')
  await expect(drive.getByTestId('admin-drive-guide')).toHaveAttribute('href', /docs\/GOOGLE-DRIVE\.md$/)
  const apps = page.getByTestId('admin-ai-apps')
  await expect(apps).toHaveAttribute('data-on', 'false')
  await expect(apps).toContainText('꺼짐')
  await expect(apps.getByTestId('admin-ai-apps-guide')).toHaveAttribute('href', /mcp-connector\.md$/)
  // state only: nothing here pretends to be a switch
  await expect(page.getByTestId('admin-app-connectors').getByRole('switch')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('a server that offers both: set up and on, what members see, and the connector address with Copy', async ({ page }) => {
  await reset(page)
  await serverOffers(page, { drive: true, connector: true })
  await signIn(page)
  await page.goto('/admin/app-connectors')
  const drive = page.getByTestId('admin-drive')
  await expect(drive).toHaveAttribute('data-on', 'true')
  await expect(drive).toContainText('설정됨')
  await expect(drive).toContainText('설정 › 앱 커넥터')
  const apps = page.getByTestId('admin-ai-apps')
  await expect(apps).toContainText('켜짐')
  await expect(apps.getByTestId('connector-address')).toContainText('https://team.example/mcp')
  await expect(apps.getByTestId('connector-address-copy')).toBeVisible()
})

test('members cannot open Admin › App connectors', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/app-connectors')
  await expect(page).not.toHaveURL(/\/admin/)
})

test('phone width: the rows stack without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await serverOffers(page, { drive: true, connector: true })
  await signIn(page)
  await page.goto('/admin/app-connectors')
  await expect(page.getByTestId('admin-ai-apps').getByTestId('connector-address')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Admin › App connectors has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await serverOffers(page, { drive: true, connector: true })
    await signIn(page)
    await page.goto('/admin/app-connectors')
    await expect(page.getByTestId('admin-ai-apps').getByTestId('connector-address')).toBeVisible()
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
  })
}
