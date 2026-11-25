// A computer's join pages open the desktop app first (lib/join-open-app.ts; docs/decisions/20261125-invite-open-app-first.md):
// a member invite and the team link try the app once on load with the "앱에서 열기" link, say it is opening, and with no
// sign of the app (this browser has none) make Download the app the one primary button; Continue in the browser shows
// the form and is remembered. A guest invite keeps the form first. SHOT_DIR=<folder> saves light and dark screenshots
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

const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}
const shot = async (p: Page, name: string) => {
  if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) })
}
/** a Mac's web browser; every try of the app's link is counted (Chromium says it found no app for it) */
async function computer(browser: Browser, o: { width?: number; colorScheme?: 'light' | 'dark' } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', userAgent: MAC, viewport: { width: o.width ?? 1440, height: 900 }, colorScheme: o.colorScheme ?? 'light' })
  const p = await ctx.newPage()
  const tries: string[] = []
  p.on('console', (m) => { if (/trina-ax:\/\//.test(m.text())) tries.push(m.text()) })
  return { ctx, p, tries }
}

test('a member invite on a computer: the app first, Download once it did not open, the browser remembered', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const { ctx, p, tries } = await computer(browser)
  await p.goto(`/invite/${token}`)
  const box = p.getByTestId('app-first')
  await expect(box).toBeVisible()
  await expect(p.getByTestId('join-form')).toHaveCount(0)
  // no app here: after the wait, Download leads (the edition's download page, nothing of this page in it)
  await expect(box).toHaveAttribute('data-phase', 'notOpened')
  await expect(p.getByTestId('app-first-status')).toHaveText(ko('auth.appNotOpened'))
  const download = p.getByTestId('app-first-download')
  await expect(download).toHaveText(ko('openApp.download'))
  expect(await download.getAttribute('href')).toBe(DOWNLOAD)
  await expect(download).toHaveClass(/bg-accent/)
  await expect(p.getByTestId('app-first-open')).toHaveText(ko('auth.openApp'))
  await expect(p.getByTestId('app-first-open')).not.toHaveClass(/bg-accent/)
  // one automatic try, never a loop
  await p.waitForTimeout(2500)
  expect(tries.length).toBeLessThanOrEqual(1)
  if (tries.length) expect(tries[0]).toContain(encodeURIComponent(`/invite/${token}`))
  // Open the app tries again on a press only
  await p.getByTestId('app-first-open').click()
  await expect(box).toHaveAttribute('data-phase', 'notOpened')
  // Continue in the browser: the form, and this browser remembers
  await p.getByTestId('app-first-browser').click()
  await expect(p.getByTestId('invite-name')).toBeVisible()
  expect(await p.evaluate(() => localStorage.getItem('mycel.joinInBrowser'))).toBe('1')
  await p.reload()
  await expect(p.getByTestId('invite-name')).toBeVisible()
  await expect(p.getByTestId('app-first')).toHaveCount(0)
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
      await expect(p.getByTestId('app-first')).toHaveAttribute('data-phase', 'notOpened')
      // nothing runs out of the page sideways
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await shot(p, `app-first-${width}-${colorScheme}`)
      await ctx.close()
    }
  }
})
