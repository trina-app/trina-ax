// A place that could not be read for the connection says so calmly and comes back by itself (components/LoadError.tsx,
// lib/autoRetry.ts; docs/DECISIONS.md "How we show errors"). The server out of reach is a read that is aborted
// (route.abort), as a dropped network does:
// - Home's 「팀에 준비된 것」: "지금 연결이 안 돼요 · 다시 연결하는 중…" on the neutral surface (no alert, nothing red), the
//   block shows once the server answers again, without a click; a draft typed meanwhile stays in the box;
// - the message box: a send that cannot reach the server keeps the text with a calm line (the block under it then waits
//   quietly: the cause is said once), and [다시 시도] sends it;
// - the rooms list: [다시 시도] reads at once; the file list comes back by itself;
// - the connection banner: the neutral surface and plain words.
// With SHOTS_DIR set, the last test saves Home (1440 light and dark, 390) and the rooms list for review.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ko } from '../../src/i18n/ko'

const BOB = { username: 'bob', password: 'bob password 1' }
const down = (page: Page, url: string | RegExp, method = 'GET') => page.route(url, (r) => (r.request().method() === method ? r.abort('internetdisconnected') : r.continue()))

/** the calm notice: words, role=status, nothing red */
async function calm(page: Page, what: string) {
  const n = page.locator(`[data-testid="load-error"][data-what="${what}"]`)
  await expect(n).toBeVisible()
  await expect(n).toHaveAttribute('data-state', 'connection')
  await expect(n).toHaveAttribute('role', 'status')
  await expect(n).toContainText(ko['conn.now'])
  await expect(n).toContainText(ko['conn.retrying'])
  await expect(n.getByTestId('load-error-retry')).toHaveText(ko['common.retry'])
  expect(await n.evaluate((el) => el.outerHTML)).not.toMatch(/danger/)
  await expect(n).not.toContainText(ko['error.network'])
  return n
}

test('Home: the prepared block says so calmly and shows once the server answers, without a click; the draft stays', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  await down(page, '**/api/skills/examples')
  await page.goto('/')
  const n = await calm(page, 'team-prepared')
  await expect(page.locator('main [role="alert"]')).toHaveCount(0)
  await page.getByTestId('composer-input').fill('이번 주 회의록 정리해 줘')
  // the server answers again: the next read (2 s) brings the block
  await page.unroute('**/api/skills/examples')
  await expect(page.getByTestId('team-prepared')).toHaveAttribute('data-state', 'ready', { timeout: 8_000 })
  await expect(n).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('이번 주 회의록 정리해 줘')
})

test('the message box: a send that cannot reach the server keeps the text, says so calmly, and [다시 시도] sends it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await down(page, '**/api/chats', 'POST')
  await page.getByTestId('composer-input').fill('이번 주 회의록 정리해 줘')
  await page.getByTestId('send').click()
  const line = page.getByTestId('composer-unsent')
  await expect(line).toBeVisible()
  await expect(line).toHaveAttribute('role', 'status')
  await expect(line).toContainText(ko['conn.unsent'])
  await expect(page.locator('main [role="alert"]')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('이번 주 회의록 정리해 줘')
  // never sent by itself
  await page.unroute('**/api/chats')
  await page.waitForTimeout(2_500)
  await expect(page).toHaveURL(/\/$/)
  await page.getByTestId('composer-unsent-retry').click()
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByTestId('user-message').first()).toContainText('이번 주 회의록 정리해 줘')
})

test('the rooms list: [다시 시도] reads at once; the file list comes back by itself', async ({ page }) => {
  await reset(page)
  await signIn(page)
  let aborted = 0
  await page.route(/\/api\/rooms$/, (r) => (r.request().method() === 'GET' ? (aborted++, r.abort('internetdisconnected')) : r.continue()))
  await page.goto('/rooms')
  await calm(page, 'rooms')
  // the first read and the one 2 s later both failed: the next by itself is 4 s away, so a read within 2 s is the click's
  const before = aborted
  await expect.poll(() => aborted, { timeout: 8_000 }).toBeGreaterThan(before)
  await page.unroute(/\/api\/rooms$/)
  await page.getByTestId('load-error-retry').click()
  await expect(page.locator('[data-testid="load-error"][data-what="rooms"]')).toHaveCount(0, { timeout: 2_000 })
  await expect(page.getByTestId('rooms-page').getByText(ko['rooms.listEmpty'])).toBeVisible()

  await down(page, /\/api\/files\/tree(\?.*)?$/)
  await page.goto('/files')
  await calm(page, 'files')
  await page.unroute(/\/api\/files\/tree(\?.*)?$/)
  await expect(page.locator('[data-testid="load-error"][data-what="files"]')).toHaveCount(0, { timeout: 8_000 })
  await expect(page.locator('main').getByText('marketing', { exact: true })).toBeVisible()
})

test('the connection banner: the neutral surface and plain words', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.request.post('/__test/drop-ws')
  const banner = page.getByTestId('conn-banner')
  await expect(banner).toContainText(ko['conn.reconnecting'])
  expect(await banner.getAttribute('class')).not.toMatch(/danger|warn/)
  await expect(banner).toHaveCount(0, { timeout: 8_000 })
})

test('screenshots for review (SHOTS_DIR)', async ({ browser }) => {
  test.skip(!process.env.SHOTS_DIR, 'only with SHOTS_DIR')
  test.setTimeout(240_000)
  const dir = process.env.SHOTS_DIR!
  for (const [name, viewport, mobile] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, locale: 'ko-KR', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { deviceScaleFactor: 1 }) })
      const page = await ctx.newPage()
      await reset(page)
      await signIn(page)
      // the owner's case: the prepared block could not be read; then a send could not reach the server either (its
      // line says it, the block waits quietly)
      await page.route('**/api/skills/examples', (r) => r.abort('internetdisconnected'))
      await down(page, '**/api/chats', 'POST')
      await page.goto('/')
      await page.getByTestId('composer-input').fill('이번 주 회의록 정리해 줘')
      await expect(page.locator('[data-testid="load-error"][data-what="team-prepared"]')).toHaveAttribute('data-state', 'connection')
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/after-home-${name}-${scheme}.png` })
      await page.getByTestId('send').click()
      await expect(page.getByTestId('composer-unsent')).toBeVisible()
      await expect(page.locator('[data-testid="load-error"][data-what="team-prepared"]')).toHaveAttribute('data-state', 'waiting')
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/after-home-unsent-${name}-${scheme}.png` })
      await down(page, /\/api\/rooms$/)
      await page.goto('/rooms')
      await expect(page.locator('[data-testid="load-error"][data-what="rooms"]')).toBeVisible()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/after-rooms-${name}-${scheme}.png` })
      // the sidebar's 트리나 기록 alone could not be read (a computer: its column; it says it, as nothing else does)
      if (!mobile) {
        await page.unroute(/\/api\/rooms$/)
        await page.unroute('**/api/skills/examples')
        await down(page, /\/api\/chats(\?.*)?$/)
        await page.goto('/')
        await expect(page.locator('[data-testid="load-error"][data-what="chats"]')).toHaveAttribute('data-state', 'connection')
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${dir}/after-sidebar-${name}-${scheme}.png` })
      }
      await ctx.close()
    }
  }
})
