// Admin › Connected apps and Settings › Connectors (QA TC-1415, TC-1416, TC-1417):
// - Slack's row and Slack's page read one state (lib/slackState.ts): connecting on both, connected on both once the
//   page has read it again, and a wait of minutes a problem on both, with what to do;
// - a row that opens a page looks like one: the list rows' hover fill, a pointer, a ›, and the keyboard's ring;
// - a sign-in in a browser window that was closed before it finished: the wait always has Try again and Cancel, and
//   ends by itself (lib/signInWait.ts) with Connect back and the flow cancelled on the server.
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const slackRow = (page: Page) => page.locator('[data-testid="connected-app"][data-id="slack"]')
const slack = async (page: Page, admin: Record<string, unknown>) => expect((await page.request.post('/__test/slack', { data: { admin } })).ok()).toBeTruthy()

test('Slack: the row and the page say the same state; the page moves on to Connected by itself; minutes of connecting are a problem on both', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await slack(page, { state: 'connecting', connectingFor: 4 })
  await page.goto('/admin/connectors')
  await expect(slackRow(page).getByTestId('connector-row-status')).toHaveText(t['slack.state.connecting'])
  await slackRow(page).getByTestId('connector-row-open').click()
  await expect(page.getByTestId('slack-status')).toContainText(t['slack.state.connecting'])
  // it connects: the page reads it again by itself, and the row on the way back says the same
  await slack(page, { state: 'connected', connectingFor: null })
  await expect(page.getByTestId('slack-status')).toContainText(t['slack.state.connected'], { timeout: 15_000 })
  await page.getByTestId('app-breadcrumb-connectors').click()
  await expect(slackRow(page).getByTestId('connector-row-status')).toHaveText(t['appConnectors.on'])

  // connecting for ten minutes: Needs attention on the row, a problem line with the next step on the page
  await slack(page, { state: 'connecting', connectingFor: 600 })
  await page.goto('/admin/connectors')
  await expect(slackRow(page).getByTestId('connector-row-status')).toHaveText(t['connectors.state.attention'])
  await slackRow(page).getByTestId('connector-row-status').click()
  await expect(page.getByTestId('slack-status')).toContainText(t['slack.state.slow'])
  await expect(page.getByTestId('slack-slow')).toContainText("Slack hasn't answered for 10 minutes. Turn it off and on again.")
  await expect(page.getByTestId('slack-toggle')).toHaveText(t['slack.admin.turnOff'])
  expect(realErrors(errors)).toEqual([])
})

test('rows that open a page look like it: hover fill, pointer, a ›, the keyboard\'s ring around the row (Connected and Discover)', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/connectors')
  const row = slackRow(page)
  const open = row.getByTestId('connector-row-open')
  await expect(open).toHaveCSS('cursor', 'pointer')
  await expect(row.getByTestId('connection-row-chevron')).toBeVisible()
  const box = row.locator('div').first()
  const before = await box.evaluate((e) => getComputedStyle(e).backgroundColor)
  await open.hover()
  await expect.poll(() => box.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(before)
  // the whole row opens it, not only its words: a click near the ›
  const chevron = await row.getByTestId('connection-row-chevron').boundingBox()
  await page.mouse.click(chevron!.x - 6, chevron!.y + chevron!.height / 2)
  await expect(page).toHaveURL(/\/admin\/connectors\/slack$/)
  await page.getByTestId('app-breadcrumb-connectors').click()
  // the keyboard: the row's button takes the focus, and its ring is drawn around the row (its ::after)
  await open.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(open).toBeFocused()
  const ring = await open.evaluate((e) => getComputedStyle(e, '::after').outlineStyle)
  expect(ring).toBe('solid')
  // Discover's rows too
  const card = page.locator('[data-testid="connector-card"]').first()
  await expect(card.getByTestId('connector-open')).toHaveCSS('cursor', 'pointer')
  await expect(card.getByTestId('connection-row-chevron')).toBeVisible()
})

const expiresAt = '2099-01-01T00:00:00.000Z'
test('Google: the window closed before it finished: Try again opens it anew, Cancel puts Connect back, and a wait that lasts ends by itself (the flow cancelled)', async ({ page }) => {
  await page.clock.install()
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const seen = { authorized: 0, cancelled: 0 }
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null } }))
  await page.route('**/api/integrations/google-drive/authorize', (r) => { seen.authorized++; return r.fulfill({ json: { flowId: `flow-${seen.authorized}`, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } }) })
  // Google never sends the person back: the window was closed
  await page.route('**/api/integrations/google-drive/flows/**', (r) => {
    if (r.request().method() === 'DELETE') { seen.cancelled++; return r.fulfill({ status: 204 }) }
    // the flow asked for (its id kept: a new id would be a new wait, with a new clock)
    return r.fulfill({ json: { flowId: r.request().url().split('/').pop(), state: 'pending', account: null, expiresAt, reason: null } })
  })
  await signIn(page)
  await page.goto('/settings/connectors/google-drive')
  const detail = page.getByTestId('drive-detail')
  let popup = page.waitForEvent('popup')
  await detail.getByTestId('drive-connect').click()
  await (await popup).close()
  await expect(detail.getByTestId('drive-waiting')).toBeVisible()
  await expect(detail.getByTestId('drive-retry-wait')).toBeVisible()
  await expect(detail.getByTestId('drive-cancel')).toBeVisible()
  // Try again: a new window, a new flow
  popup = page.waitForEvent('popup')
  await detail.getByTestId('drive-retry-wait').click()
  await (await popup).close()
  await expect.poll(() => seen.authorized).toBe(2)
  // Cancel: Connect is back, the flow cancelled on the server
  await detail.getByTestId('drive-cancel').click()
  await expect(detail.getByTestId('drive-connect')).toBeVisible()
  await expect.poll(() => seen.cancelled).toBe(1)
  // waiting for minutes: it ends by itself, says so, and cancels the flow there
  popup = page.waitForEvent('popup')
  await detail.getByTestId('drive-connect').click()
  await (await popup).close()
  await expect(detail.getByTestId('drive-waiting')).toBeVisible()
  await page.clock.fastForward('05:01')
  // the timers the jump made due run on the page's next ticks
  await page.waitForTimeout(2000)
  await expect(detail.getByTestId('drive-connect')).toBeVisible()
  await expect(detail.getByTestId('drive-error')).toHaveText(t['connect.wait.timedOut'])
  await expect.poll(() => seen.cancelled).toBe(2)
})

test('a service\'s sign-in (MCP): Try again shows from the start of the wait, Cancel cancels the flow on the server, a long wait ends as timed out', async ({ page }) => {
  await page.clock.install()
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.context().route('https://auth.example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Sign in</title><p>Synthetic sign-in page</p>' }))
  // the service never sends the person back
  let cancelled = 0
  await page.route('**/api/integrations/flows/**', (r) => {
    if (r.request().method() === 'DELETE') { cancelled++; return r.continue() }
    return r.fulfill({ json: { flowId: r.request().url().split('/').pop(), state: 'pending', expiresAt, reason: null } })
  })
  await signIn(page)
  await page.goto('/connectors')
  await page.getByTestId('integration-add').click()
  await page.getByTestId('integration-name').fill('Notion')
  await page.getByTestId('integration-url').fill('https://mcp.notion.example/mcp')
  let popup = page.waitForEvent('popup')
  await page.getByTestId('integration-save').click()
  await (await popup).close()
  const panel = page.getByTestId('integration-signin')
  await expect(panel).toContainText(t['integrations.signIn.waiting'])
  await expect(panel.getByTestId('integration-signin-retry')).toBeVisible()
  await panel.getByTestId('integration-signin-cancel').click()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => cancelled).toBe(1)
  // again, and left: after five minutes it stops waiting (timed out, Try again and Close), cancelled there too
  popup = page.waitForEvent('popup')
  await page.getByTestId('connector-detail').getByTestId('integration-signin-start').click()
  await (await popup).close()
  await expect(panel).toContainText(t['integrations.signIn.waiting'])
  await page.clock.fastForward('05:01')
  await page.waitForTimeout(2000)
  await expect(panel).toContainText(t['integrations.signIn.expired'])
  await expect(panel.getByTestId('integration-signin-retry')).toBeVisible()
  await expect.poll(() => cancelled).toBe(2)
})
