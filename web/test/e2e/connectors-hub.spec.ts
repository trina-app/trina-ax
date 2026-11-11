// Connectors (pages/Connectors.tsx in the sidebar, pages/admin/Integrations.tsx, components/integrations/ConnectorsView.tsx):
// MCP and Google's apps on one page, what is connected first and Popular under it (Drive and the Google apps first, the
// rest behind Show all); a card opens the connector's page, /connectors/<id> (big logo, Connect, what it does, its tools),
// and its way back returns to the page; Admin keeps Discover; the add dialog is one column, Name and Server URL, with type, sign-in, write rule and (Admin)
// who connects and who may use it under a collapsed Advanced. Google Drive's own flow: drive.spec.ts and
// admin-app-connectors.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const header = (page: Page) => page.getByTestId('connectors-header')
/** Popular (Settings) or Discover (Admin) is on the page under the connections: its heading is there */
const discover = (page: Page, title = '인기') => expect(page.getByTestId('connector-discover-title')).toHaveText(title)
const card = (page: Page, id: string) => page.locator(`[data-testid="connector-card"][data-id="${id}"]`)

test('Popular: Google Drive first, the rest behind Show all; a card opens its page with Connect', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/connectors')
  // the same noun as Admin's; no tabs
  await expect(header(page).getByRole('heading', { name: '연결한 서비스', exact: true })).toBeVisible()
  await expect(header(page).getByRole('tab')).toHaveCount(0)
  await discover(page)
  const top = page.getByTestId('connector-list').getByTestId('connector-card')
  await expect(top).toHaveCount(10)
  await expect(top.first()).toHaveAttribute('data-id', 'google-drive')
  await page.getByTestId('connector-show-all').click()
  await expect(top).not.toHaveCount(10)

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
  // back: the list again
  await detail.getByTestId('connector-back').click()
  await expect(page).toHaveURL(/\/connectors$/)
  await discover(page)
  expect(realErrors(errors)).toEqual([])
})

test('Add custom connector: Name and Server URL, the rest under Advanced; an API key connection lands in the connections', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/connectors')
  await header(page).getByTestId('integration-add').click()
  const dialog = page.getByRole('dialog', { name: '주소로 서비스 추가' })
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
  await page.goto('/connectors')
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
  await discover(page, '둘러보기')
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

test('Settings › Connectors leads to the Connectors page in the sidebar', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-settings').click()
  const settings = page.getByTestId('settings-dialog')
  await settings.getByTestId('settings-menu').getByRole('link', { name: '연결한 서비스', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/)
  await expect(settings).toHaveCount(0)
  await expect(header(page).getByRole('heading', { name: '연결한 서비스', exact: true })).toBeVisible()
  await expect(page.getByTestId('nav-connectors')).toHaveAttribute('aria-current', 'page')
  expect(realErrors(errors)).toEqual([])
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
  await page.goto('/connectors')
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
    await page.goto('/connectors')
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
    await page.getByTestId('connector-back').click()
    await header(page).getByTestId('integration-add').click()
    await page.getByRole('dialog').getByTestId('integration-advanced').click()
    expect(await audit()).toEqual([])
  })
}
