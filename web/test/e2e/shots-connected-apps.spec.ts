// Screenshots of Admin › Connected apps (QA TC-1415, TC-1416, TC-1417), 1440 and 390 wide, light and dark, for reviewing
// by eye: the list with a row hovered, Slack's page in each state, and a connect wait with Try again and Cancel. Only
// when CONNECTED_APPS_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.CONNECTED_APPS_SHOTS
test.skip(!dir, 'CONNECTED_APPS_SHOTS is not set')
test.use({ locale: 'en-US' })

const slack = async (page: Page, admin: Record<string, unknown>) => expect((await page.request.post('/__test/slack', { data: { admin } })).ok()).toBeTruthy()
const expiresAt = '2099-01-01T00:00:00.000Z'
const STATES: Record<string, Record<string, unknown>> = {
  connected: { state: 'connected' },
  connecting: { state: 'connecting', connectingFor: 6 },
  slow: { state: 'connecting', connectingFor: 420 },
  off: { enabled: false, state: 'off' },
  error: { state: 'error', lastError: 'unreachable' },
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`connected apps screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const shot = (name: string) => page.screenshot({ path: `${dir}/${name}-${vp.name}-${scheme}.png` })
      // the list: Slack connecting on its row, a row hovered (Connected) and one of Discover
      await slack(page, STATES.connecting)
      await page.goto('/admin/connectors')
      const row = page.locator('[data-testid="connected-app"][data-id="slack"]')
      await expect(row).toBeVisible()
      await row.getByTestId('connector-row-open').hover()
      await page.waitForTimeout(200)
      await shot('list-hover-connected')
      const card = page.locator('[data-testid="connector-card"]').first()
      await card.scrollIntoViewIfNeeded()
      await card.getByTestId('connector-open').hover()
      await page.waitForTimeout(200)
      await shot('list-hover-discover')
      // the keyboard's ring on a row
      await row.scrollIntoViewIfNeeded()
      await row.getByTestId('connector-row-open').focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(200)
      await shot('list-focus')
      // Slack's page in each state, and its row
      for (const [name, admin] of Object.entries(STATES)) {
        await slack(page, admin)
        await page.goto('/admin/connectors')
        await expect(row).toBeVisible()
        await shot(`list-slack-${name}`)
        await page.goto('/admin/connectors/slack')
        await expect(page.getByTestId('slack-status')).toBeVisible()
        await page.waitForTimeout(200)
        await shot(`slack-page-${name}`)
      }
      // a connect wait: Google Drive's page, the window closed before it finished
      await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
      await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null } }))
      await page.route('**/api/integrations/google-drive/authorize', (r) => r.fulfill({ json: { flowId: 'f1', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } }))
      await page.route('**/api/integrations/google-drive/flows/**', (r) => r.request().method() === 'DELETE' ? r.fulfill({ status: 204 }) : r.fulfill({ json: { flowId: 'f1', state: 'pending', account: null, expiresAt, reason: null } }))
      await page.goto('/settings/connectors/google-drive')
      const popup = page.waitForEvent('popup')
      await page.getByTestId('drive-detail').getByTestId('drive-connect').click()
      await (await popup).close()
      await expect(page.getByTestId('drive-waiting')).toBeVisible()
      await page.waitForTimeout(200)
      await shot('wait-drive')
      // a service's sign-in (MCP), waiting
      await page.context().route('https://auth.example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic sign-in page</p>' }))
      await page.route('**/api/integrations/flows/**', (r) => r.request().method() === 'DELETE' ? r.continue() : r.fulfill({ json: { flowId: 'x', state: 'pending', expiresAt, reason: null } }))
      await page.goto('/connectors')
      await page.getByTestId('integration-add').click()
      await page.getByTestId('integration-name').fill('Notion')
      await page.getByTestId('integration-url').fill('https://mcp.notion.example/mcp')
      const popup2 = page.waitForEvent('popup')
      await page.getByTestId('integration-save').click()
      await (await popup2).close()
      await expect(page.getByTestId('integration-signin')).toBeVisible()
      await page.waitForTimeout(200)
      await shot('wait-mcp')
    })
  }
}
