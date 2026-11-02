// What a running upload says, in a real browser: XMLHttpRequest's own counts on a slowed connection (Chromium's network
// emulation), on the chat chip, the file list and the folder row. Runs in WebKit too, without the emulation: refusals,
// a lost connection and the end of an upload through the iPhone's engine.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { OWNER, reset, signIn } from './helpers'

const CHIP = '[data-testid="attachment-chip"] [role="status"]'
const ROW = '[data-testid="upload-list"] li'

/** From now on, every different text the element shows, with its bar's width if it has one. */
async function record(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const seen: string[] = []
    Object.assign(window, { __seen: seen })
    const read = () => {
      const el = document.querySelector(sel)
      if (!el) return
      const bar = el.querySelector<HTMLElement>('.bg-accent')?.style.width
      const now = (el.textContent ?? '').trim() + (bar ? ` bar=${bar}` : '')
      if (now && now !== seen.at(-1)) seen.push(now)
    }
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] })
  }, selector)
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
/** the percents shown, in the order shown (not the bar's) */
const percents = (list: string[]) => list.flatMap((s) => /(?:^|[^=\d])(\d+)%/.exec(s)?.[1] ?? []).map(Number)
const ascending = (list: number[]) => [...list].sort((a, b) => a - b)

/** Uploads go at this speed; the emulation keeps the rest of the page as it is. */
async function slowUploads(page: Page, bytesPerSecond: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSecond })
}
const answerAfter = (page: Page, ms: number) => page.request.post('/__test/upload-delay', { data: { ms } })
const pdf = (name: string, size: number) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(size, 7) })

test.describe('on a slow connection', () => {
  test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'the network emulation is a Chromium tool'))

  test('chat, a small file: counts up while it goes out, says it is finishing, and ends attached', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await answerAfter(page, 700)
    await record(page, CHIP)
    await slowUploads(page, 400_000)
    await page.getByTestId('file-input').setInputFiles(pdf('slow.pdf', 1_000_000))
    const chip = page.getByTestId('attachment-chip')
    await expect(chip).toContainText('마무리 중')
    await expect(chip).toHaveAttribute('data-status', 'done')
    await expect(chip).toContainText('KB')
    const shown = await seen(page)
    const pct = percents(shown)
    expect(pct.length, shown.join(' | ')).toBeGreaterThan(2)
    expect(pct).toEqual(ascending(pct))
    expect(Math.min(...pct)).toBeGreaterThan(0)
    expect(Math.max(...pct)).toBeLessThan(100)
    expect(shown[0]).toBe('준비 중')
    expect(shown.at(-2)).toBe('마무리 중')
    expect(shown.at(-1)).toContain('slow.pdf 첨부했어요')
  })

  test('a screen reader: a fixed text while the number runs, and the end in the same live region', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await answerAfter(page, 400)
    await slowUploads(page, 400_000)
    await page.getByTestId('file-input').setInputFiles(pdf('slow.pdf', 1_000_000))
    const chip = page.getByTestId('attachment-chip')
    const status = chip.getByRole('status')
    const region = await status.elementHandle()
    await expect(status.locator('span[aria-hidden="true"]')).toContainText('%')
    await expect(status.locator('.sr-only')).toHaveText('slow.pdf 첨부하는 중')
    await expect(chip).toHaveAttribute('data-status', 'done')
    expect(await region!.evaluate((el) => el.isConnected)).toBe(true)
    await expect(status.locator('.sr-only')).toHaveText('slow.pdf 첨부했어요')
    await expect(status.locator('span[aria-hidden="true"]')).toHaveCount(0)
  })

  test('a running upload writes nothing to the tab\'s storage: only a finished chip does', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __chips: number }
      w.__chips = 0
      const { setItem, removeItem } = Storage.prototype
      Storage.prototype.setItem = function (k, v) { if (k.startsWith('mycel.chips:')) w.__chips++; return setItem.call(this, k, v) }
      Storage.prototype.removeItem = function (k) { if (k.startsWith('mycel.chips:')) w.__chips++; return removeItem.call(this, k) }
    })
    await reset(page)
    await signIn(page)
    await page.getByTestId('file-input').setInputFiles(pdf('first.pdf', 1000))
    const first = page.getByTestId('attachment-chip').first()
    await expect(first).toHaveAttribute('data-status', 'done')
    await page.evaluate(() => { (window as unknown as { __chips: number }).__chips = 0 })
    await slowUploads(page, 400_000)
    await page.getByTestId('file-input').setInputFiles(pdf('second.pdf', 1_000_000))
    await expect(page.getByTestId('attachment-chip').nth(1)).toHaveAttribute('data-status', 'done')
    expect(await page.evaluate(() => (window as unknown as { __chips: number }).__chips)).toBe(1)
  })

  test('chat, a chunked file: hashing shows no number, and the count never falls back', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await record(page, CHIP)
    await slowUploads(page, 4_000_000)
    await page.getByTestId('file-input').setInputFiles(pdf('big.pdf', 9 * 1024 * 1024))
    const chip = page.getByTestId('attachment-chip')
    await expect(chip).toHaveAttribute('data-status', 'done', { timeout: 40_000 })
    const shown = await seen(page)
    const pct = percents(shown)
    expect(pct.length, shown.join(' | ')).toBeGreaterThan(2)
    expect(pct).toEqual(ascending(pct))
    expect(Math.max(...pct)).toBeLessThan(100)
    expect(shown[0]).toBe('준비 중')
    expect(shown.at(-2)).toBe('마무리 중')
  })

  test('chat, a chunk that fails once and is sent again: the count stays where it was', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await record(page, CHIP)
    // the first try of the second chunk ends in a 503 when its bytes are in; the upload sends it again by itself
    let tries = 0
    await page.route(/\/api\/upload-sessions\/[^/]+\/chunks\/1$/, (route) => (tries++ ? route.continue() : route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'x' } }) })))
    await slowUploads(page, 6_000_000)
    await page.getByTestId('file-input').setInputFiles(pdf('again.pdf', 12 * 1024 * 1024))
    await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done', { timeout: 40_000 })
    expect(tries).toBe(2)
    const pct = percents(await seen(page))
    expect(pct.length).toBeGreaterThan(1)
    expect(pct).toEqual(ascending(pct))
  })

  test('file list: the same words, and the bar only goes forward', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('files-input')).toBeAttached()
    await answerAfter(page, 500)
    await record(page, ROW)
    await slowUploads(page, 4_000_000)
    await page.getByTestId('files-input').setInputFiles(pdf('big-list.pdf', 9 * 1024 * 1024))
    await expect(page.getByTestId('upload-list')).toContainText('마무리 중', { timeout: 40_000 })
    await expect(page.locator(ROW)).toHaveAttribute('data-status', 'done')
    await expect(page.locator(ROW).getByRole('status')).toHaveText('big-list.pdf 올렸어요')
    const shown = await seen(page)
    const pct = percents(shown)
    expect(pct.length, shown.join(' | ')).toBeGreaterThan(2)
    expect(pct).toEqual(ascending(pct))
    const bars = shown.flatMap((s) => /bar=(\d+)%/.exec(s)?.[1] ?? []).map(Number)
    expect(bars).toEqual(ascending(bars))
    expect(bars.at(-1)).toBe(100)
  })

  test('a folder of small files: the bar moves within a file, and the sum ends at the size of the folder', async ({ page }, info) => {
    const dir = path.join(info.outputDir, 'clips')
    fs.mkdirSync(dir, { recursive: true })
    for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(dir, `${n}.bin`), Buffer.alloc(300_000, 3))
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('folder-upload-button')).toBeEnabled()
    await record(page, '[data-testid="folder-upload"]')
    await slowUploads(page, 600_000)
    await page.getByTestId('folder-input').setInputFiles(dir)
    await expect(page.getByTestId('folder-upload-counts')).toContainText('4개 중 4개', { timeout: 20_000 })
    await expect(page.getByTestId('folder-upload').locator('.text-ok')).toBeVisible({ timeout: 20_000 })
    const counts = (await page.getByTestId('folder-upload-counts').textContent()) ?? ''
    const [total, done] = counts.split(' · ')[1]!.split(' 중 ').map((s) => s.trim())
    expect(done).toBe(total)
    const shown = await seen(page)
    const bars = shown.flatMap((s) => /bar=(\d+)%/.exec(s)?.[1] ?? []).map(Number)
    expect(bars, shown.join(' | ')).toEqual(ascending(bars))
    expect(Math.max(...bars)).toBeLessThanOrEqual(100)
    // not only whole files: with four files of the same size, a share between the quarters
    expect(bars.some((b) => b % 25 !== 0), shown.join(' | ')).toBe(true)
  })

  test('removing the chip stops the upload: no error, and the message box is free again', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await slowUploads(page, 100_000)
    const stopped = page.waitForEvent('requestfailed', (r) => /\/api\/uploads$/.test(r.url()))
    await page.getByTestId('file-input').setInputFiles(pdf('stop-me.pdf', 2_000_000))
    const chip = page.getByTestId('attachment-chip')
    await expect(chip).toContainText('%')
    await chip.getByRole('button', { name: /stop-me\.pdf/ }).last().click()
    await expect(chip).toHaveCount(0)
    expect((await stopped).failure()?.errorText).toContain('ABORTED')
  })
})

test.describe('without the service worker', () => {
  // WebKit's page.route does not see a request of a page that a service worker controls
  test.use({ serviceWorkers: 'block' })

  test('a server\'s refusal and a lost connection show on the chip, in red, through the same upload', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.route(/\/api\/uploads$/, (route) => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: { code: 'storage_full', message: '저장 공간이 가득 찼어요' } }) }))
    await page.getByTestId('file-input').setInputFiles(pdf('full.pdf', 1000))
    const chip = page.getByTestId('attachment-chip')
    await expect(chip.getByRole('alert')).toContainText('저장 공간')
    await expect(chip.getByRole('alert')).toHaveClass(/text-danger/)
    await chip.getByRole('button').last().click()
    await expect(chip).toHaveCount(0)
    await page.unroute(/\/api\/uploads$/)
    await page.route(/\/api\/uploads$/, (route) => route.abort('connectionfailed'))
    await page.getByTestId('file-input').setInputFiles(pdf('lost.pdf', 1000))
    await expect(chip).toHaveAttribute('data-status', 'failed')
    await expect(chip.getByRole('alert')).not.toContainText('Network request failed')
    await expect(chip.getByRole('alert')).not.toBeEmpty()
  })

  test('a server that kept another size: the chip is red, not attached', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.route(/\/api\/uploads$/, async (route) => {
      const res = await route.fetch()
      await route.fulfill({ response: res, json: { ...(await res.json()), size: 0 } })
    })
    await page.getByTestId('file-input').setInputFiles(pdf('empty-on-server.pdf', 1000))
    const chip = page.getByTestId('attachment-chip')
    await expect(chip.getByRole('alert')).toContainText('파일이 다 도착하지 않았어요')
    await expect(chip).toHaveAttribute('data-status', 'failed')
  })

  test('the file list says a failure aloud too, and a row stays when the person comes back', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('files-input')).toBeAttached()
    await page.route(/\/api\/files\/upload$/, (route) => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: { code: 'storage_full', message: '저장 공간이 가득 찼어요' } }) }))
    await page.getByTestId('files-input').setInputFiles(pdf('full.pdf', 1000))
    const row = page.locator(ROW)
    await expect(row.getByRole('alert')).toContainText('저장 공간')
    await page.getByRole('link', { name: '프로젝트', exact: true }).click()
    await expect(row).toHaveCount(0)
    await page.getByRole('link', { name: '파일', exact: true }).click()
    await expect(row.getByRole('alert')).toContainText('저장 공간')
  })

  test('sign-out: the next person in this tab sees no row of the last one', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('files-input')).toBeAttached()
    await page.route(/\/api\/files\/upload$/, (route) => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: { code: 'storage_full', message: 'x' } }) }))
    await page.getByTestId('files-input').setInputFiles(pdf('private-name.pdf', 1000))
    await expect(page.locator(ROW)).toContainText('private-name.pdf')
    await page.getByTestId('account-menu').click()
    await page.getByTestId('logout').click()
    // no page load here (signIn would make one, and an empty page proves nothing): the same tab, as at a shared computer
    await expect(page.getByTestId('login-username')).toBeVisible()
    await page.getByTestId('login-username').fill(OWNER.username)
    await page.getByTestId('login-password').fill(OWNER.password)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('account-menu')).toBeVisible()
    await page.getByRole('link', { name: '파일', exact: true }).click()
    await expect(page.getByTestId('files-input')).toBeAttached()
    await expect(page.getByText('private-name.pdf')).toHaveCount(0)
  })
})

test('from the file to the message: a watched upload goes through, in each engine', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await answerAfter(page, 300)
  await record(page, CHIP)
  await page.getByTestId('file-input').setInputFiles(pdf('report.pdf', 200 * 1024))
  const chip = page.getByTestId('attachment-chip')
  await expect(chip).toHaveAttribute('data-status', 'done')
  await expect(chip).toContainText('KB')
  const shown = await seen(page)
  expect(shown.join(' | ')).not.toMatch(/(^|\D)(0|100)%/)
  await page.getByTestId('composer-input').fill('summarize')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('user-message').first()).toContainText('report.pdf')
})

test('a phone 320 px wide: the chip with its longest words stays on the screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await reset(page)
  await signIn(page)
  await answerAfter(page, 3000)
  await page.getByTestId('file-input').setInputFiles(pdf('a-report-with-a-very-long-name-from-the-finance-team-2026.pdf', 1000))
  const chip = page.getByTestId('attachment-chip')
  await expect(chip).toContainText('마무리 중')
  const box = (await chip.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(320)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
})
