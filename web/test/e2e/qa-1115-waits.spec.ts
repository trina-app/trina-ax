// QA 2026-11-15: what a person sees while something is under way, and the message box's file chips.
// - TC-2132: a sign-in wait (Google Drive's page, "Add to Slack") shows a spinner and a truthful limit ("This stops by
//   itself after 5 minutes", from SIGN_IN_WAIT_MS), and Slack's "Connecting" a spinner and when it becomes a problem.
// - TC-2142: Slack's page before it is added says what the app will read.
// - TC-2285 (a): a failed file's reason beside its chip is shown in full, not cut with "…".
// - The file chip's ✕ is a 24 px target on a computer and 44 px on a phone (as PictureTile's since PR #839).
// At 1440 and 390. SHOTS_DIR=<folder>: each state at 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const t = DICTS.en
const limit = 'This stops by itself after 5 minutes.'
const FULL = 'The storage is full. Empty the trash or clean up files.'
// page.route must see every request (a service worker's fetches it does not)
test.use({ serviceWorkers: 'block' })
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'layout checks in Chromium'))

const WIDTHS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }] as const

async function shots(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(dir, `${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** The line is not cut: no ellipsis, all its words inside its box */
async function notCut(el: Locator) {
  const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, overflow: getComputedStyle(e).textOverflow, ws: getComputedStyle(e).whiteSpace }))
  expect(m.overflow).not.toBe('ellipsis')
  expect(m.ws).not.toBe('nowrap')
  expect(m.sw).toBeLessThanOrEqual(m.cw + 1)
}

for (const vp of WIDTHS) {
  test.describe(`${vp.w} px`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } })

    test('Google Drive: waiting for Google shows a spinner and how long it waits', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      const expiresAt = '2099-01-01T00:00:00.000Z'
      const disconnected = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
      await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
      await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: disconnected }))
      await page.route('**/api/integrations/google-drive/authorize', (r) => r.fulfill({ json: { flowId: 'fixture-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } }))
      await page.route('**/api/integrations/google-drive/flows/**', (r) => r.request().method() === 'DELETE'
        ? r.fulfill({ status: 204 })
        : r.fulfill({ json: { flowId: 'fixture-flow', state: 'pending', account: null, expiresAt, reason: null } }))
      await signIn(page)
      await page.goto('/connectors/google-drive')
      const detail = page.getByTestId('drive-detail')
      const popup = page.waitForEvent('popup')
      await detail.getByTestId('drive-connect').click()
      await (await popup).close()
      const wait = detail.getByTestId('drive-waiting')
      await expect(wait).toBeVisible()
      await expect(wait.locator('.animate-spin')).toBeVisible()
      await expect(wait.getByTestId('drive-waiting-line')).toContainText(t['drive.waitingShort'])
      await expect(wait.getByTestId('drive-waiting-line-hint')).toHaveText(limit)
      await expect(wait.getByTestId('drive-retry-wait')).toBeVisible()
      await expect(wait.getByTestId('drive-cancel')).toBeVisible()
      await page.mouse.move(0, 0)
      await shots(page, 'drive-waiting')
    })

    test('Slack before it is added: what it reads, then Add to Slack waits with a spinner and its limit', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      expect((await page.request.post('/__test/slack', { data: { admin: { mode: 'official', official: true, tokens: false, enabled: false, workspace: null, botName: null, state: 'off', lastError: null } } })).ok()).toBeTruthy()
      await page.route('**/api/admin/slack/official/install', (r) => r.fulfill({ json: { authorizationUrl: 'https://slack.com/oauth/v2/authorize?state=synthetic' } }))
      // Slack's page answers nothing to show: this page stays, as in the desktop and phone apps
      await page.context().route('https://slack.com/**', (r) => r.abort('aborted'))
      await page.goto('/admin/connectors/slack')
      const card = page.getByTestId('slack-official')
      await expect(card.getByTestId('slack-reads')).toHaveText(t['slack.reads'].replace('{product}', 'Trina AX'))
      await notCut(card.getByTestId('slack-reads'))
      await page.mouse.move(0, 0)
      await shots(page, 'slack-before-added')
      await card.getByTestId('slack-add').click()
      const wait = page.getByTestId('slack-add-waiting')
      await expect(wait).toBeVisible()
      await expect(wait.locator('.animate-spin')).toBeVisible()
      await expect(wait.getByTestId('slack-add-waiting-line-hint')).toHaveText(limit)
      await page.mouse.move(0, 0)
      await shots(page, 'slack-add-waiting')
    })

    test('Slack connecting: a spinner on its row and on its page, with when it stops being a wait', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      expect((await page.request.post('/__test/slack', { data: { admin: { enabled: true, state: 'connecting' } } })).ok()).toBeTruthy()
      await page.goto('/admin/connectors')
      const row = page.locator('[data-testid="connected-app"][data-id="slack"]')
      await expect(row.getByTestId('connector-row-status')).toHaveText(t['slack.state.connecting'])
      await expect(row.getByTestId('connector-row-status').locator('.animate-spin')).toBeVisible()
      await page.mouse.move(0, 0)
      await shots(page, 'slack-row-connecting')
      await row.getByTestId('connector-row-open').click()
      const line = page.getByTestId('slack-connecting')
      await expect(line).toContainText(t['slack.connecting.text'])
      await expect(line.locator('.animate-spin')).toBeVisible()
      await expect(page.getByTestId('slack-connecting-hint')).toHaveText('This usually takes a few seconds. If it takes more than 2 minutes, this page says what to do.')
      await page.mouse.move(0, 0)
      await shots(page, 'slack-page-connecting')
    })

    test("the AI chat's box: a file refused for a full disk says so in full, and its ✕ is a big enough target", async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await page.route(/\/api\/uploads$/, (route) => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: { code: 'storage_full', message: FULL } }) }))
      await page.getByTestId('file-input').setInputFiles({ name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1000, 1) })
      const chip = page.getByTestId('attachment-chip')
      await expect(chip).toHaveAttribute('data-status', 'failed')
      const alert = chip.getByRole('alert')
      await expect(alert).toContainText(FULL)
      await notCut(alert)
      // the whole chip is on the screen (a phone's row scrolls sideways, but one chip never needs it)
      const b = (await chip.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(vp.w)
      const x = (await chip.getByTestId('chip-remove').boundingBox())!
      const min = vp.w < 768 ? 44 : 24
      expect(x.width).toBeGreaterThanOrEqual(min)
      expect(x.height).toBeGreaterThanOrEqual(min)
      await page.mouse.move(0, 0)
      await shots(page, 'chat-chip-storage-full')
      await chip.getByTestId('chip-remove').click()
      await expect(chip).toHaveCount(0)
    })

    test("a room's box: the same full reason and the same ✕ target", async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await routeRoom(page, { members: [{ id: 'ben', name: 'Ben' }], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: { id: 'ben', name: 'Ben' }, body: 'Send the report please' }] })
      await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), (route) => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: { code: 'storage_full', message: FULL } }) }))
      await page.goto(`/rooms/${ROOM_ID}`)
      await page.getByTestId('room-file-input').setInputFiles({ name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1000, 1) })
      const chip = page.getByTestId('room-file-chip')
      await expect(chip).toHaveAttribute('data-status', 'failed')
      const why = chip.getByRole('status')
      await expect(why).toContainText(FULL)
      await notCut(why)
      const x = (await chip.getByTestId('chip-remove').boundingBox())!
      const min = vp.w < 768 ? 44 : 24
      expect(x.width).toBeGreaterThanOrEqual(min)
      expect(x.height).toBeGreaterThanOrEqual(min)
      await page.mouse.move(0, 0)
      await shots(page, 'room-chip-storage-full')
      await chip.getByTestId('chip-remove').click()
      await expect(chip).toHaveCount(0)
    })
  })
}
