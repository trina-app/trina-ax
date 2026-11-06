// AI apps in Settings › AI apps (pages/AiApps.tsx) and Admin › AI apps (pages/admin/AiApps.tsx), a section of their own
// since App connectors became the apps the AI here connects to (components/integrations/AiAppConnect.tsx): one row per
// app (Claude, Claude Code, other MCP apps), Connect opens numbered steps with the real connector address and Copy, the
// dialog notices when the app has connected, and a server with the connector off tells members one line and gives owners
// and admins the setup. Drive: drive.spec.ts; Admin › App connectors: admin-app-connectors.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const RESOURCE = 'https://team.example/mcp'
const app = { id: 'synthetic-grant', clientName: 'Synthetic Claude', scopes: ['mcp:read', 'mcp:write', 'offline_access'], createdAt: '2026-11-05T01:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', currentSession: true }
const BOB = { username: 'bob', password: 'bob password 1' }

/** GET /api/connectors/remote like a server with the connector on (or off); `state.items` is what it lists. */
async function connector(page: Page, on = true) {
  const state = { items: [] as object[], calls: 0 }
  await page.route('**/api/connectors/remote', (r) => { state.calls++; return r.fulfill({ json: { configured: on, resource: on ? RESOURCE : null, items: state.items } }) })
  return state
}

const apps = (page: Page) => page.getByTestId('ai-app-list')

test('three AI apps, each with a logo and Connect; Claude opens three steps with the real address and Copy', async ({ page }) => {
  await reset(page)
  await connector(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/ai-apps')
  await expect(apps(page).locator(':scope > li')).toHaveCount(3)
  await expect(page.getByTestId('ai-app-claude').getByTestId('connector-logo')).toHaveAttribute('src', '/icons/connectors/claude.svg')
  await expect(page.getByTestId('ai-app-claude-code').getByTestId('connector-logo')).toHaveAttribute('src', '/icons/connectors/claude.svg')
  await expect(page.getByTestId('ai-app-other').getByTestId('connector-logo')).toHaveCount(0)
  await page.getByTestId('ai-app-connect-claude').click()
  const dialog = page.getByRole('dialog', { name: 'Claude 연결' })
  await expect(dialog.getByTestId('ai-app-steps').locator(':scope > li')).toHaveCount(3)
  await expect(dialog.getByTestId('ai-app-address')).toContainText(RESOURCE)
  await dialog.getByTestId('ai-app-address-copy').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(RESOURCE)
  await expect(dialog.getByTestId('ai-app-status')).toHaveAttribute('data-state', 'waiting')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('ai-app-connect-claude')).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

test('Claude Code: the exact command to copy, then /mcp; other apps: the address and what cannot connect yet', async ({ page }) => {
  await reset(page)
  await connector(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await signIn(page)
  await page.goto('/settings/ai-apps')
  await page.getByTestId('ai-app-connect-claude-code').click()
  const code = page.getByRole('dialog', { name: 'Claude Code 연결' })
  const command = `claude mcp add --transport http trina-ax ${RESOURCE}`
  await expect(code.getByTestId('ai-app-command')).toContainText(command)
  await code.getByTestId('ai-app-command-copy').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command)
  await expect(code.getByTestId('ai-app-mcp')).toContainText('/mcp')
  await code.getByTestId('ai-app-done').click()
  await page.getByTestId('ai-app-connect-other').click()
  const other = page.getByRole('dialog', { name: '다른 MCP 앱 연결' })
  await expect(other.getByTestId('ai-app-address')).toContainText(RESOURCE)
  await expect(other.getByTestId('ai-app-limit')).toContainText('ChatGPT')
})

test('the dialog says Connected when the app appears, and the list then shows it with Disconnect', async ({ page }) => {
  await reset(page)
  const state = await connector(page)
  await signIn(page)
  await page.goto('/settings/ai-apps')
  await page.getByTestId('ai-app-connect-claude').click()
  const status = page.getByRole('dialog').getByTestId('ai-app-status')
  await expect(status).toHaveAttribute('data-state', 'waiting')
  state.items = [app]
  await expect(status).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
  await expect(status).toContainText('Synthetic Claude')
  await page.getByTestId('ai-app-done').click()
  const connected = page.getByTestId('connected-apps')
  await expect(connected.getByTestId('connector-item')).toHaveCount(1)
  await expect(connected.getByTestId('connector-item')).toContainText('Synthetic Claude')
  await expect(connected.getByRole('button', { name: '연결 해제', exact: true })).toBeVisible()
  // closed: no more asking
  const after = state.calls
  await page.waitForTimeout(5000)
  expect(state.calls).toBe(after)
})

test('connector off: a member sees one line and no Connect; an owner gets the setup with Copy and the guide', async ({ page }) => {
  await reset(page)
  await connector(page, false)
  await signIn(page, BOB)
  await page.goto('/settings/ai-apps')
  await expect(page.getByTestId('ai-apps-off')).toHaveText('관리자가 아직 켜지 않았어요.')
  await expect(page.getByTestId('ai-apps-setup')).toHaveCount(0)
  await expect(page.getByTestId('ai-app-connect-claude')).toHaveCount(0)
  await expect(page.getByTestId('connector-address')).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page)
  await page.goto('/settings/ai-apps')
  const setup = page.getByTestId('ai-apps-setup')
  await expect(setup.getByTestId('ai-apps-setup-installer')).toContainText('--public-host HOST --app-connectors')
  await expect(setup.getByTestId('ai-apps-setup-json')).toContainText('"appConnectors": true')
  await expect(setup.getByTestId('ai-apps-setup-env')).toContainText('MYCEL_REMOTE_MCP_ORIGIN=')
  await expect(setup.getByTestId('ai-apps-guide')).toHaveAttribute('href', /mcp-connector\.md$/)
  await expect(page.getByTestId('ai-app-connect-claude')).toHaveCount(0)
})

test('Admin › AI apps: in the Admin menu, the same three apps with Connect when on, the setup when off', async ({ page }) => {
  await reset(page)
  await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: { configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null } }))
  let on = true
  await page.route('**/api/connectors/remote', (r) => r.fulfill({ json: { configured: on, resource: on ? RESOURCE : null, items: [] } }))
  await signIn(page)
  await page.goto('/admin')
  await page.getByTestId('admin-menu').getByRole('link', { name: 'AI 앱' }).click()
  await expect(page).toHaveURL(/\/admin\/ai-apps$/)
  await expect(page.getByTestId('admin-ai-apps-header')).toContainText('AI 앱')
  const list = page.getByTestId('admin-ai-app-list')
  await expect(list.locator(':scope > li')).toHaveCount(3)
  await list.getByTestId('ai-app-connect-claude-code').click()
  await expect(page.getByRole('dialog', { name: 'Claude Code 연결' }).getByTestId('ai-app-command')).toContainText(RESOURCE)
  await page.keyboard.press('Escape')
  on = false
  await page.reload()
  await expect(page.getByTestId('admin-ai-apps').getByTestId('ai-apps-setup')).toBeVisible()
  await expect(list.getByTestId('ai-app-connect-claude')).toHaveCount(0)
})

test('phone width: the rows and a dialog fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await connector(page)
  await signIn(page)
  await page.goto('/settings/ai-apps')
  await expect(page.getByTestId('ai-app-claude')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByTestId('ai-app-connect-claude-code').click()
  await expect(page.getByRole('dialog').getByTestId('ai-app-command')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`AI apps and their dialog have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    const state = await connector(page)
    state.items = [app]
    await signIn(page)
    await page.goto('/settings/ai-apps')
    await expect(page.getByTestId('connected-apps')).toBeVisible()
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    expect(await audit()).toEqual([])
    await page.getByTestId('ai-app-connect-claude').click()
    await expect(page.getByRole('dialog').getByTestId('ai-app-steps')).toBeVisible()
    expect(await audit()).toEqual([])
  })
}
