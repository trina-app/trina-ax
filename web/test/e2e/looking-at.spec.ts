// What the window tells the server it shows, and Ask Trina on a shared file's page (docs/decisions/
// 20261116-ai-screen-and-shared-tools.md; QA "Manual AI tests" MAN-015, MAN-020).
// - Each change of the address or the side panel sends one `looking` frame on the socket: the screen and ids only. A
//   window where nothing changes sends no frame and asks the server nothing.
// - /f/<id>: "Ask Trina" opens a new chat with the file's link ready in the box.
// LOOKING_SHOTS names a folder: the page with the button at 1440 and 390, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const SHOTS = process.env.LOOKING_SHOTS
const BOB = { username: 'bob', password: 'bob password 1' }
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
const year = new Date().getFullYear()

async function world(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  const grants = [{ path: 'users/olga/Hiring plan.md', to: 'bob', by: 'olga', at: `${year}-11-10T09:00:00.000Z` }]
  expect((await post(page, '/__test/file-shares', { grants })).ok()).toBeTruthy()
}

/** the `looking` frames this page sends, oldest first */
function watchLooking(page: Page): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = []
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    try { const j = JSON.parse(String(f.payload)); if (j?.type === 'looking') sent.push(j) } catch { /* not ours */ }
  }))
  return sent
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

test('each change of screen sends one frame with ids only; an idle window sends nothing and asks nothing', async ({ page }) => {
  await world(page)
  const sent = watchLooking(page)
  await signIn(page, BOB)
  await page.goto('/files?view=shared')
  await expect.poll(() => sent.at(-1)?.screen).toBe('shared_files')
  await page.getByTestId('shared-file').filter({ hasText: 'Hiring plan.md' }).click()
  await expect(page).toHaveURL(/\/f\/[A-Za-z0-9_-]{22}$/)
  const linkId = page.url().split('/f/')[1]!
  await expect.poll(() => sent.at(-1)).toEqual({ type: 'looking', screen: 'shared_file', linkId })
  // ids only: never the file's name or the page's text
  for (const f of sent) {
    expect(Object.keys(f).every((k) => ['type', 'screen', 'chatId', 'projectId', 'roomId', 'threadRootId', 'filePath', 'linkId'].includes(k))).toBe(true)
    expect(JSON.stringify(f)).not.toContain('Hiring')
  }
  // a team file opened in the viewer: its path
  await page.goto('/files/view?path=marketing%2Fnotes.txt')
  await expect.poll(() => sent.at(-1)).toEqual({ type: 'looking', screen: 'file', filePath: 'marketing/notes.txt' })

  // idle: no frame and no request for it while nothing changes
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  const before = sent.length
  const requests: string[] = []
  page.on('request', (r) => requests.push(new URL(r.url()).pathname))
  await page.waitForTimeout(4000)
  expect(sent.length).toBe(before)
  expect(requests.filter((p) => /look/i.test(p))).toEqual([])
  // the same address again (a re-render, a replaced history entry) sends nothing either
  await page.evaluate(() => window.history.replaceState(window.history.state, '', window.location.href))
  await page.waitForTimeout(800)
  expect(sent.length).toBe(before)
})

test('a reconnect tells the current screen once more', async ({ page }) => {
  await world(page)
  const sent = watchLooking(page)
  await signIn(page, BOB)
  await page.goto('/files?view=shared')
  await expect.poll(() => sent.at(-1)?.screen).toBe('shared_files')
  const before = sent.length
  // the server closes this window's socket; the page connects again and says where it is
  expect((await post(page, '/__test/drop-ws')).ok()).toBeTruthy()
  await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(before + 1)
  expect(sent.at(-1)).toEqual({ type: 'looking', screen: 'shared_files' })
})

test('Ask Trina on a shared file\'s page opens a new chat with the file\'s link in the box', async ({ page }) => {
  await world(page)
  await signIn(page, BOB)
  await page.goto('/files?view=shared')
  await page.getByTestId('shared-file').filter({ hasText: 'Hiring plan.md' }).click()
  await expect(page.getByTestId('file-link-name')).toHaveText('Hiring plan.md')
  const linkId = page.url().split('/f/')[1]!
  const ask = page.getByTestId('file-link-ask-ai')
  await expect(ask).toBeVisible()
  await expect(ask).toHaveText(/Ask Trina/)
  // beside Download, the same height
  const [a, d] = await Promise.all([ask.boundingBox(), page.getByTestId('file-link-download').boundingBox()])
  expect(Math.round(a!.height)).toBe(Math.round(d!.height))
  expect(a!.x + a!.width).toBeLessThanOrEqual(d!.x)
  if (SHOTS) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForTimeout(250)
        await page.screenshot({ path: `${SHOTS}/file-link-ask-${w}-${theme}.png` })
      }
    }
    // a phone: the icon alone, still named for a screen reader and big enough to tap
    const box = await ask.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(32)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
  }
  await ask.click()
  await expect(page).toHaveURL(/\/\?prompt=/)
  const input = page.getByTestId('composer-input')
  await expect(input).toBeVisible()
  const text = (await input.inputValue().catch(() => null)) ?? (await input.innerText())
  expect(text).toContain('Hiring plan.md')
  expect(text).toContain(`/f/${linkId}`)
  // nothing was sent yet: the person writes their question after it
  await expect(page).toHaveURL(/\/\?prompt=/)
  if (SHOTS) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForTimeout(250)
        await page.screenshot({ path: `${SHOTS}/file-link-asked-${w}-${theme}.png` })
      }
    }
  }
})
