// Connectors (pages/Connectors.tsx in the sidebar, pages/admin/Integrations.tsx, components/integrations/ConnectorsView.tsx):
// MCP and Google's apps on one page, Your connectors first and Discover under it (what can be added now first, what is
// not set up yet last, the rest behind Show all); a card opens the connector's page, /connectors/<id> (big logo, Connect, what it does, its tools),
// and its way back returns to the page; Admin keeps Discover; the add dialog is one column, Name and Server URL, with type, sign-in, write rule and (Admin)
// who connects and who may use it under a collapsed Advanced. Google Drive's own flow: drive.spec.ts and
// admin-app-connectors.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const header = (page: Page) => page.getByTestId('connectors-header')
/** Discover is on the page under the connections: its heading is there */
const discover = (page: Page, title = '둘러보기') => expect(page.getByTestId('connector-discover-title')).toHaveText(title)
const card = (page: Page, id: string) => page.locator(`[data-testid="connector-card"][data-id="${id}"]`)

test('Discover: the Google ones first (QA TC-138, also not set up), the rest behind Show all; a card opens its page with Connect', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/connectors')
  // no tabs
  await expect(header(page).getByRole('heading', { name: '커넥터', exact: true })).toBeVisible()
  await expect(header(page).getByRole('tab')).toHaveCount(0)
  await discover(page)
  const top = page.getByTestId('connector-list').getByTestId('connector-card')
  await expect(top).toHaveCount(10)
  await expect(top.first()).toHaveAttribute('data-id', 'google-drive')
  await expect(top.nth(5)).toHaveAttribute('data-id', 'notion')
  await page.getByTestId('connector-show-all').click()
  await expect(top).not.toHaveCount(10)

  // a card opens its page: big logo, the line, Connect, what it does, and its tools once connected
  await card(page, 'notion').getByTestId('connector-open').click()
  const detail = page.getByTestId('connector-detail')
  await expect(detail.getByRole('heading', { name: 'Notion' })).toBeVisible()
  await expect(detail.getByTestId('connector-back')).toBeFocused()
  // before connecting (QA TC-132): the tools Notion lists on its own page, and its privacy, terms and help pages
  await expect(detail.getByTestId('connector-tools-listed').locator('li').first()).toHaveText('notion-search')
  await expect(detail.getByTestId('connector-tools-link')).toHaveAttribute('href', 'https://developers.notion.com/guides/mcp/mcp-supported-tools')
  await expect(detail.getByTestId('connector-privacy-link')).toHaveAttribute('href', 'https://www.notion.com/trust/privacy-policy')
  // the rest of the listed tools in place (QA final), the service's page still linked
  await expect(detail.getByTestId('connector-tools-listed').locator('li')).toHaveCount(12)
  await detail.getByTestId('connector-tools-more').click()
  await expect(detail.getByTestId('connector-tools-more')).toHaveAttribute('aria-expanded', 'true')
  await expect(detail.getByTestId('connector-tools-listed').locator('li').last()).toHaveText('notion-calendar-cancel-events')
  await expect(detail.getByTestId('connector-tools-link')).toBeVisible()
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
  // an API with no sign-in and no usage notes saves; the point here is that Advanced shows its choices in one line, in
  // plain words: no kind ("MCP 서버" / "API") and no sign-in where there is none (QA TC-204)
  await expect(dialog.getByTestId('integration-advanced-summary')).toHaveText('매번 묻기')
})

test('Admin: a connector page Connects with one team key, and its ⌄ makes a template for the whole team', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  await discover(page, '둘러보기')
  await card(page, 'linear').getByTestId('connector-open').click()
  const detail = page.getByTestId('connector-detail')
  // the main button connects for the team (QA TC-134); the ⌄ has a template and the admin's own
  await expect(detail.getByTestId('connector-connect')).toHaveText('팀용으로 연결')
  await detail.getByTestId('integration-add-more').click()
  await expect(page.getByTestId('connector-connect-mine')).toHaveText('나만 쓰기')
  await page.getByTestId('connector-connect-template').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByTestId('integration-advanced').click()
  await expect(dialog.getByTestId('integration-who-template')).toBeChecked()
  await expect(dialog.getByTestId('integration-access-everyone')).toBeChecked()
  await dialog.getByRole('button', { name: '취소' }).click()
  await detail.getByTestId('connector-connect').click()
  await page.getByRole('dialog').getByTestId('integration-advanced').click()
  await expect(page.getByRole('dialog').getByTestId('integration-who-team')).toBeChecked()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  // members may not add their own (Team settings): no "Just for me" either, the server would refuse it
  expect((await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { personalIntegrations: false } })).ok()).toBeTruthy()
  await page.reload()
  await page.getByTestId('connector-detail').getByTestId('integration-add-more').click()
  await expect(page.getByTestId('connector-connect-template')).toBeVisible()
  await expect(page.getByTestId('connector-connect-mine')).toHaveCount(0)
})

test('Connectors is in Settings, not in the sidebar; the old addresses lead to it (QA TC-400)', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('nav-connectors')).toHaveCount(0)
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-settings').click()
  const settings = page.getByTestId('settings-dialog')
  const item = settings.getByTestId('settings-menu').getByRole('link', { name: '커넥터', exact: true })
  // in the Connections group, first
  await expect(settings.getByTestId('settings-group-connections').getByRole('link').first()).toHaveText('커넥터')
  await item.click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  // (Admin's Connectors stays under the dialog, with the same cards: look inside Settings)
  await expect(settings.getByTestId('connectors-header').getByRole('heading', { name: '커넥터', exact: true })).toBeVisible()
  // a connector's page under it keeps the section marked, and its way back is the list
  await settings.locator('[data-testid="connector-card"][data-id="notion"]').getByTestId('connector-open').click()
  await expect(page).toHaveURL(/\/settings\/connectors\/notion$/)
  await expect(item).toHaveClass(/font-medium/)
  await settings.getByTestId('connector-back').click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  // closing Settings goes back to the page under it, Admin's Connectors (unchanged)
  await page.getByTestId('settings-close').click()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  // the old addresses, with their query, open the same place in Settings over the page they came from
  for (const [old, now] of [['/connectors', '/settings/connectors'], ['/connectors/notion', '/settings/connectors/notion'], ['/settings/integrations', '/settings/connectors'], ['/settings/drive', '/settings/connectors/google-drive']]) {
    await page.goto(old)
    await expect(page).toHaveURL(new RegExp(`${now.replace(/\//g, '\\/')}$`))
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
  }
  await page.goto('/connectors/notion?x=1#y')
  await expect(page).toHaveURL(/\/settings\/connectors\/notion\?x=1#y$/)
  expect(realErrors(errors)).toEqual([])
})

test('the old Admin addresses lead to Connectors', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/integrations')
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  // App connectors' old address opens Google Drive's page, which has an address of its own
  await page.goto('/admin/app-connectors')
  await expect(page).toHaveURL(/\/admin\/connectors\/google-drive$/)
  await expect(page.getByTestId('drive-admin-detail')).toBeVisible()
})

test('phone width: Discover and a connector page fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/connectors')
  await discover(page)
  await expect(card(page, 'notion')).toBeVisible()
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
    await expect(card(page, 'notion')).toBeVisible()
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

// QA TC-179: a template the team set up (here Notion) is in Your connectors with Connect until the member connects it,
// and not offered again in Discover
test('a team template for a listed service shows once: in Your connectors, not again in Discover', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const made = await page.request.post('/api/admin/integration-templates', { headers: { [CSRF_HEADER]: '1' }, data: { kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth' } })
  expect(made.status()).toBe(201)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/connectors')
  await discover(page)
  await expect(page.getByTestId('connected-apps').getByTestId('template-row').filter({ hasText: 'Notion' })).toHaveCount(1)
  await page.getByTestId('connector-show-all').click()
  await expect(card(page, 'notion')).toHaveCount(0)
})

// QA TC-134 retest: "Connect for the team" is for the whole team unless the admin narrows it under Advanced
test('Admin: "Connect for the team" saved without opening Advanced reaches the whole team', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.context().route('https://mcp.linear.app/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic sign-in</p>' }))
  await page.goto('/admin/connectors')
  await discover(page, '둘러보기')
  await card(page, 'linear').getByTestId('connector-open').click()
  await page.getByTestId('connector-detail').getByTestId('connector-connect').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('integration-advanced')).toHaveAttribute('aria-expanded', 'false')
  // who it is for, without opening Advanced; Change opens the chooser
  await expect(dialog.getByTestId('integration-for')).toContainText('쓸 사람: 팀 전체')
  await dialog.getByTestId('integration-for-change').click()
  await expect(dialog.getByTestId('integration-advanced')).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByTestId('integration-access-everyone')).toBeFocused()
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/admin/integrations') && r.method() === 'POST')
  await dialog.getByTestId('integration-save').click()
  expect((await sent).postDataJSON()).toMatchObject({ name: 'Linear', access: { everyone: true, groups: [], users: [] } })
})
