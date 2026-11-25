// A computer's join pages open the desktop app first (lib/join-open-app.ts; docs/decisions/20261125-invite-open-app-first.md):
// a member invite and the team link lead with Open the app (the "앱에서 열기" link), Download the app second, try the app
// once by itself where that is harmless, and never say whether it opened; Continue in the browser shows the form and is
// remembered. A guest invite keeps the form first. SHOT_DIR=<folder> saves light and dark screenshots
// at 1440 and 390.
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

// a fresh browser: nothing remembered (the config starts every other spec as one that chose the browser)
test.use({ storageState: { cookies: [], origins: [] } })

const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DOWNLOAD = 'https://ax.trina.app/download'
// Safari's own string (no Chrome token); the page is still Chromium here, which fails the try as it would
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'

const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}
const shot = async (p: Page, name: string) => {
  if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) })
}
/** a Mac's web browser; every try of the app's link is counted (Chromium fails the request: no app answers it).
 * `hidden`: the tab loads in the background (cmd-click from a mail) until `show()`. */
async function computer(browser: Browser, o: { width?: number; colorScheme?: 'light' | 'dark'; userAgent?: string; hidden?: boolean } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', userAgent: o.userAgent ?? MAC, viewport: { width: o.width ?? 1440, height: 900 }, colorScheme: o.colorScheme ?? 'light' })
  if (o.hidden)
    await ctx.addInitScript(() => {
      const w = window as unknown as { __vis: string }
      w.__vis = 'hidden'
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => w.__vis })
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => w.__vis === 'hidden' })
    })
  const p = await ctx.newPage()
  const tries: string[] = []
  p.on('requestfailed', (r) => { if (r.url().startsWith('trina-ax://')) tries.push(r.url()) })
  const show = () => p.evaluate(() => { (window as unknown as { __vis: string }).__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
  return { ctx, p, tries, show }
}

test('a member invite on a computer: Open the app leads, one try by itself, never "opened", the browser remembered', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const { ctx, p, tries } = await computer(browser)
  await p.goto(`/invite/${token}`)
  const box = p.getByTestId('app-first')
  await expect(box).toBeVisible()
  await expect(p.getByTestId('join-form')).toHaveCount(0)
  // exactly one try by itself, with the same link as "앱에서 열기"; the line says only what to do either way
  await expect(box).toHaveAttribute('data-tried', 'true')
  await p.waitForTimeout(2500)
  expect(tries).toEqual([`trina-ax://open?url=${encodeURIComponent(`${new URL(p.url()).origin}/invite/${token}`)}`])
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appTried'))
  // Open the app leads; Download the app is the clear second choice (the edition's download page, nothing of this page)
  await expect(p.getByTestId('app-first-open')).toHaveText(ko('auth.openApp'))
  await expect(p.getByTestId('app-first-open')).toHaveClass(/bg-accent/)
  const download = p.getByTestId('app-first-download')
  await expect(download).toHaveText(ko('openApp.download'))
  expect(await download.getAttribute('href')).toBe(DOWNLOAD)
  await expect(download).not.toHaveClass(/bg-accent/)
  // already a member: a quiet sign-in line, which does not remember the browser
  await expect(p.getByTestId('join-signin')).toBeVisible()
  // Open the app tries again on a press only
  await p.getByTestId('app-first-open').click()
  await expect.poll(() => tries.length).toBe(2)
  expect(await p.evaluate(() => localStorage.getItem('mycel.joinInBrowser'))).toBeNull()
  // Download in a new tab, focus gone and back: the page says the same, nothing about the app having opened
  await ctx.route(/^https:\/\/ax\.trina\.app\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>download</title>' }))
  const [dl] = await Promise.all([ctx.waitForEvent('page'), download.click()])
  await p.evaluate(() => window.dispatchEvent(new Event('blur')))
  await dl.close()
  await p.bringToFront()
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appTried'))
  // Continue in the browser: the form, and this browser remembers
  await p.getByTestId('app-first-browser').click()
  await expect(p.getByTestId('invite-name')).toBeVisible()
  expect(await p.evaluate(() => localStorage.getItem('mycel.joinInBrowser'))).toBe('1')
  await p.reload()
  await expect(p.getByTestId('invite-name')).toBeVisible()
  await expect(p.getByTestId('app-first')).toHaveCount(0)
  await ctx.close()
})

test('a tab opened in the background tries nothing until it is seen', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const { ctx, p, tries, show } = await computer(browser, { hidden: true })
  await p.goto(`/invite/${token}`)
  const box = p.getByTestId('app-first')
  await expect(box).toBeVisible()
  await p.waitForTimeout(3000)
  expect(tries).toEqual([])
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appReady'))
  await show()
  await expect.poll(() => tries.length).toBe(1)
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appTried'))
  await ctx.close()
})

test('Safari: no try by itself (its alert would cover the page); the press of Open the app is the try', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const { ctx, p, tries } = await computer(browser, { userAgent: SAFARI })
  await p.goto(`/invite/${token}`)
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appReady'))
  await p.waitForTimeout(2500)
  expect(tries).toEqual([])
  await shot(p, 'app-first-safari-1440-light')
  await p.getByTestId('app-first-open').click()
  await expect.poll(() => tries.length).toBe(1)
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appTried'))
  await ctx.close()
})

test('the team link on a computer leads with the app too', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const link = await post(page, '/api/admin/team-link', {})
  const url = new URL(link.link.url)
  const { ctx, p } = await computer(browser)
  await p.goto(url.pathname + url.hash)
  await expect(p.getByTestId('app-first')).toBeVisible()
  // the page took the token out of the address bar as before
  expect(new URL(p.url()).hash).toBe('')
  await p.getByTestId('app-first-browser').click()
  await expect(p.getByTestId('join-form')).toBeVisible()
  await ctx.close()
})

test('a guest invite on a computer keeps the browser first', async ({ page, browser }) => {
  await reset(page)
  const GROUP = uuidv7()
  const at = new Date(Date.now() - 3600_000).toISOString()
  const room = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, id: GROUP, kind: 'group', name: '견적 준비', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }
  expect((await page.request.post('/__test/rooms', { data: { rooms: [room] } })).ok()).toBeTruthy()
  await signIn(page)
  const invite = await post(page, '/api/guest-invites', { place: { kind: 'room', id: GROUP }, name: 'Gina' })
  const token = invite.token as string
  const { ctx, p } = await computer(browser)
  await p.goto(`/invite/${token}`)
  await expect(p.getByTestId('invite-name')).toBeVisible()
  await expect(p.getByTestId('app-first')).toHaveCount(0)
  await ctx.close()
})

test('the app-first page at 1440 and 390, light and dark', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390]) {
      const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
      const { ctx, p } = await computer(browser, { width, colorScheme })
      await p.goto(`/invite/${token}`)
      await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appTried'))
      // nothing runs out of the page sideways
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await shot(p, `app-first-${width}-${colorScheme}`)
      await ctx.close()
    }
  }
})
