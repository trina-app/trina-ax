// After a dropped connection (QA TC-231; docs/DECISIONS.md "QA 11-11 polish"): a page part that could not load while the
// server was out of reach says it loads by itself and does, once the live connection is back, with no click
// (components/ChunkErrorBoundary.tsx); Home's goal card, read while the connection was down, comes back by itself too
// (components/onboarding/GoalCard.tsx HomeGoal). "Down" here: the live connection cannot open (routeWebSocket closes
// it) and the reads in question fail as a dropped network does (route.abort). The service worker is blocked, so the
// page's own requests are the ones routed. That nothing reloads while something would be lost is in the unit tests
// (test/unit/chunk-reload.test.ts).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { ko } from '../../src/i18n/ko'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })

const FILES_CHUNK = /\/assets\/Files-[\w-]+\.js$/

/** the live connection: open as usual until `down.on`; then every new connection is closed at once */
async function liveConnection(page: Page) {
  const down = { on: false }
  await page.routeWebSocket(/\/api\/ws/, (ws) => { if (down.on) void ws.close(); else ws.connectToServer() })
  return down
}

/** the connection drops and stays down: the banner says it is reconnecting */
async function drop(page: Page, down: { on: boolean }) {
  down.on = true
  expect((await page.request.post('/__test/drop-ws', { headers: { [CSRF_HEADER]: '1' } })).ok()).toBe(true)
  await expect(page.getByTestId('conn-banner')).toBeVisible()
}

/** the connection is back: new connections open, nudged as when the browser comes back online */
async function back(page: Page, down: { on: boolean }) {
  down.on = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
}

test('Files opened while the connection is down: it says it loads by itself, and it does once the connection is back, no click', async ({ page }) => {
  await reset(page)
  const down = await liveConnection(page)
  await signIn(page)
  await drop(page, down)
  // a page not loaded before cannot load now
  await page.route(FILES_CHUNK, (r) => r.abort('internetdisconnected'))
  await page.evaluate(() => { (window as unknown as { beforeReload?: boolean }).beforeReload = true })
  await page.getByTestId('nav-files').click()
  const alert = page.getByRole('alert').filter({ hasText: ko['update.chunkOffline'] })
  await expect(alert).toBeVisible()
  await expect(page.getByText(ko['update.chunkFailed'])).toHaveCount(0)
  // the connection is back: the page loads again by itself (a reload: this page's marker is gone) and shows the files
  await page.unroute(FILES_CHUNK)
  await back(page, down)
  await expect(page.getByTestId('file-row').first()).toBeVisible({ timeout: 15_000 })
  expect(new URL(page.url()).pathname).toBe('/files')
  expect(await page.evaluate(() => (window as unknown as { beforeReload?: boolean }).beforeReload ?? null)).toBeNull()
  await expect(alert).toHaveCount(0)
})

test('Home\'s goal card, read while the connection was down, comes back by itself once it is back', async ({ page }) => {
  await reset(page)
  const down = await liveConnection(page)
  await signIn(page)
  const start = Date.now() - 86_400_000
  expect((await page.request.post('/__test/team-goal', { headers: { [CSRF_HEADER]: '1' }, data: { goal: {
    state: 'open', target: 3, days: 7, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * 86_400_000).toISOString(), daysLeft: 6,
    skill: null, reachedAt: null, joined: 1, waiting: { first: '민지', more: 0 },
  } } })).ok()).toBe(true)
  await page.goto('/')
  await expect(page.getByTestId('team-goal')).toBeVisible()
  // the connection drops; Files and back to Home: the goal cannot be read now
  await drop(page, down)
  await page.route('**/api/onboarding/goal', (r) => r.abort('internetdisconnected'))
  await page.getByTestId('nav-files').click()
  await expect(page.getByTestId('file-row').first()).toBeVisible()
  await page.evaluate(() => { (window as unknown as { beforeReload?: boolean }).beforeReload = true })
  await page.getByTestId('new-chat').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('team-goal')).toHaveCount(0)
  // back: the card comes back, without a reload of the page
  await page.unroute('**/api/onboarding/goal')
  await back(page, down)
  await expect(page.getByTestId('team-goal')).toBeVisible({ timeout: 15_000 })
  expect(await page.evaluate(() => (window as unknown as { beforeReload?: boolean }).beforeReload ?? null)).toBe(true)
})

test('screenshots for review (RECONNECT_SHOTS): the line while the connection is down, 1440 and 390 light', async ({ browser }) => {
  test.skip(!process.env.RECONNECT_SHOTS, 'only with RECONNECT_SHOTS')
  for (const [name, viewport, mobile] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const) {
    const ctx = await browser.newContext({ viewport, colorScheme: 'light', locale: 'ko-KR', serviceWorkers: 'block', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
    const page = await ctx.newPage()
    await reset(page)
    const down = await liveConnection(page)
    await signIn(page)
    await drop(page, down)
    await page.route(FILES_CHUNK, (r) => r.abort('internetdisconnected'))
    await page.goto('/').catch(() => {})
    await page.evaluate(() => { history.pushState({}, '', '/files'); dispatchEvent(new PopStateEvent('popstate')) })
    await expect(page.getByRole('alert').filter({ hasText: ko['update.chunkOffline'] })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${process.env.RECONNECT_SHOTS}/tc231-offline-line-${name}-light.png` })
    await ctx.close()
  }
})
