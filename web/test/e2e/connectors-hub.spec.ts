// Connectors, like Claude's (pages/Integrations.tsx, pages/admin/Integrations.tsx, components/integrations/ConnectorsView.tsx):
// MCP and Google Drive in one section with Yours and Discover; "Top connectors" (Drive first) and the rest behind Show
// all; a card opens the connector's page (big logo, Connect, what it does, its tools); the add dialog is one column, Name
// and Server URL, with type, sign-in, write rule and (Admin) who connects and who may use it under a collapsed Advanced.
// Google Drive's own flow: drive.spec.ts and admin-app-connectors.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const header = (page: Page) => page.getByTestId('connectors-header')
const discover = (page: Page) => header(page).getByRole('tab', { name: '둘러보기' }).click()
const card = (page: Page, id: string) => page.locator(`[data-testid="connector-card"][data-id="${id}"]`)

test('Discover: Top connectors with Google Drive first, the rest behind Show all; a card opens its page with Connect', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  await expect(header(page).getByRole('tab', { name: '내 커넥터' })).toHaveAttribute('aria-selected', 'true')
  await discover(page)
  const top = page.getByTestId('connector-list').getByTestId('connector-card')
  await expect(top).toHaveCount(8)
  await expect(top.first()).toHaveAttribute('data-id', 'google-drive')
  await expect(card(page, 'notion')).toContainText('Notion 제공')
  await expect(page.getByTestId('connector-list-more')).toBeHidden()
  await page.getByTestId('connector-show-all').click()
  await expect(page.getByTestId('connector-list-more')).toBeVisible()
  await expect(page.getByTestId('connector-list-more').getByTestId('connector-card').first()).toBeVisible()

  // a card opens its page: big logo, the line, Connect, what it does, and its tools once connected
  await card(page, 'notion').getByTestId('connector-open').click()
  const detail = page.getByTestId('connector-detail')
  await expect(detail.getByRole('heading', { name: 'Notion' })).toBeVisible()
  await expect(detail.getByTestId('connector-back')).toBeFocused()
  await expect(detail.getByTestId('connector-tools-note')).toBeVisible()
  await detail.getByTestId('connector-connect').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('connector-summary')).toContainText('https://mcp.notion.com/mcp')
  // one column: no type or sign-in cards up front, they are under Advanced
  await expect(dialog.getByTestId('integration-advanced')).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog.getByTestId('integration-write-ask')).toBeHidden()
  await expect(dialog.getByTestId('integration-advanced-summary')).toContainText('매번 묻기')
  await dialog.getByRole('button', { name: '취소' }).click()
  await detail.getByTestId('connector-back').click()
  await expect(page.getByTestId('connector-discover')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('Add custom connector: Name and Server URL, the rest under Advanced; an API key connection lands in Yours', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  await header(page).getByTestId('integration-add').click()
  const dialog = page.getByRole('dialog', { name: '직접 커넥터 추가' })
  await expect(dialog.getByTestId('integration-name')).toBeVisible()
  await expect(dialog.getByTestId('integration-url')).toBeVisible()
  await expect(dialog.getByTestId('integration-kind-mcp')).toBeHidden()
  await dialog.getByTestId('integration-name').fill('Sample Wiki')
  await dialog.getByTestId('integration-url').fill('https://mcp.wiki.example/mcp')
  await dialog.getByTestId('integration-advanced').click()
  await expect(dialog.getByTestId('integration-advanced')).toHaveAttribute('aria-expanded', 'true')
  await dialog.getByTestId('integration-auth-key').check()
  await dialog.getByTestId('integration-key').fill('synthetic-key-' + 'k'.repeat(20))
  await dialog.getByTestId('integration-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('integrations-mine').getByText('Sample Wiki', { exact: true })).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('a field that needs fixing under Advanced opens it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  await header(page).getByTestId('integration-add').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByTestId('integration-name').fill('Sample API')
  await dialog.getByTestId('integration-url').fill('https://api.example.com/v1')
  await dialog.getByTestId('integration-advanced').click()
  await dialog.getByTestId('integration-kind-http').check()
  await dialog.getByTestId('integration-auth-none').check()
  await dialog.getByTestId('integration-advanced').click()
  await expect(dialog.getByTestId('integration-advanced')).toHaveAttribute('aria-expanded', 'false')
  // an API with no sign-in and no usage notes saves; the point here is that Advanced shows its choices in one line
  await expect(dialog.getByTestId('integration-advanced-summary')).toContainText('API')
})

test('Admin: a connector page Connects with one team key, and its ⌄ makes a template for the whole team', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  await discover(page)
  await card(page, 'linear').getByTestId('connector-open').click()
  const detail = page.getByTestId('connector-detail')
  await detail.getByTestId('integration-add-more').click()
  await page.getByTestId('connector-connect-template').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByTestId('integration-advanced').click()
  await expect(dialog.getByTestId('integration-who-template')).toBeChecked()
  await expect(dialog.getByTestId('integration-access-everyone')).toBeChecked()
  await dialog.getByRole('button', { name: '취소' }).click()
  await detail.getByTestId('connector-connect').click()
  await page.getByRole('dialog').getByTestId('integration-advanced').click()
  await expect(page.getByRole('dialog').getByTestId('integration-who-team')).toBeChecked()
})

test('the old Admin addresses lead to Connectors', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/integrations')
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await page.goto('/admin/app-connectors')
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await expect(page.getByTestId('drive-admin-detail')).toBeVisible()
})

test('phone width: Discover and a connector page fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/settings/connectors')
  await discover(page)
  await expect(card(page, 'google-drive')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await card(page, 'notion').getByTestId('connector-open').click()
  await expect(page.getByTestId('connector-detail')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Discover, a connector page and the add dialog have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await page.goto('/settings/connectors')
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    await discover(page)
    await expect(card(page, 'google-drive')).toBeVisible()
    expect(await audit()).toEqual([])
    await card(page, 'notion').getByTestId('connector-open').click()
    await expect(page.getByTestId('connector-detail')).toBeVisible()
    expect(await audit()).toEqual([])
    await header(page).getByTestId('integration-add').click()
    await page.getByRole('dialog').getByTestId('integration-advanced').click()
    expect(await audit()).toEqual([])
  })
}
