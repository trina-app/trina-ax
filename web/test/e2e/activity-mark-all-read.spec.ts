// Activity's "Mark all as read" (web/src/pages/Activity.tsx, QA TC-457) at 1440 and 390 wide: a quiet button at the end
// of the tools row while the open tab has something unread; one click reads that tab (POST /api/notifications/read)
// and only that tab, its dot goes, the button goes; the row of tools never scrolls the page sideways. With SHOTS=1 it
// saves each step, light and dark, into $SHOTS_DIR (default test-results/activity-mark-all-read).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
type Item = Record<string, unknown> & { readAt: string | null; code: string; room?: Record<string, unknown> }
const base = (n: number, code: string, minutes: number) => ({ id: id(n), eventType: code, sourceId: id(n + 1000), code, createdAt: ago(minutes), readAt: null, chatId: null, link: 'room', outcome: null })
function inbox(): Item[] {
  return [
    { ...base(1, 'room.mention', 3), room: { id: id(390), from: '민준', fromId: 'minjun', kind: 'team', name: '디자인 리뷰', reason: 'mention', message: id(590), preview: '@Olga 시안 확인 부탁해요', count: 2, people: 1, at: ago(3) } },
    { ...base(2, 'room.dm', 20), room: { id: id(391), from: '서연', fromId: 'seoyeon', kind: 'dm', name: null, reason: 'reply', thread: id(700), message: id(591), preview: '회의 자료 올렸어요', count: 1, people: 1, at: ago(20) } },
    { ...base(3, 'room.mention', 60), room: { id: id(392), from: '지호', fromId: 'jiho', kind: 'team', name: '마케팅', reason: 'everyone', message: id(592), preview: '@전체 내일 오전 회의', count: 1, people: 1, at: ago(60) } },
  ]
}
/** the same tab rule as shared activityTabHas */
const inTab = (x: Item, tab: string) => {
  if (tab === 'all') return true
  const r = x.room
  if (!r) return false
  if (tab === 'dms') return r.kind === 'dm' || r.kind === 'group'
  if (tab === 'mentions') return x.code === 'room.mention' || r.reason === 'mention' || r.reason === 'everyone'
  return !!r.thread
}
async function routeInbox(page: Page) {
  let items = inbox()
  const sent: unknown[] = []
  await page.route('**/api/notifications?*', (route) => route.fulfill({ json: { items, nextCursor: null, unreadCount: items.filter((x) => !x.readAt).length, roomUnreadCount: items.filter((x) => !x.readAt).length } }))
  await page.route('**/api/notifications/read', async (route) => {
    const body = route.request().postDataJSON() as { tab: string }
    sent.push(body)
    let read = 0
    items = items.map((x) => (x.readAt || !inTab(x, body.tab) ? x : (read++, { ...x, readAt: new Date().toISOString() })))
    await route.fulfill({ json: { read } })
  })
  return sent
}

const SIZES = [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const
const dir = process.env.SHOTS_DIR ?? 'test-results/activity-mark-all-read'

for (const [name, viewport, mobile] of SIZES) {
  test(`${name} wide: "Mark all as read" reads the open tab only`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, locale: 'ko-KR', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
    const page = await ctx.newPage()
    await reset(page)
    await signIn(page)
    const sent = await routeInbox(page)
    await page.goto('/activity?tab=threads')
    const button = page.getByTestId('activity-mark-all-read')
    await expect(button).toBeVisible()
    await expect(button).toHaveText('모두 읽음 표시')
    // in the tools row, on one line, inside the page; at least 44px tall on a phone
    const box = (await button.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    if (mobile) expect(box.height).toBeGreaterThanOrEqual(44)
    const tools = (await page.getByTestId('activity-tools').boundingBox())!
    expect(box.y).toBeLessThan(tools.y + tools.height)
    if (process.env.SHOTS) for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      // the tabs' colours move with a transition: let it end before the picture
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/mark-all-${name}-${scheme}-before.png` })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await button.click()
    await expect(page.getByTestId('activity-tab-threads-unread')).toHaveCount(0)
    await expect(button).toHaveCount(0)
    // a computer: Threads is 대화's 멘션·스레드 now (/activity?in=chats, nav rail P3), so the rooms' notices only
    expect(sent).toEqual([mobile ? { tab: 'threads' } : { tab: 'threads', only: 'rooms' }])
    // the other tabs keep theirs: Mentions still has two unread, All its button
    await expect(page.getByTestId('activity-tab-mentions-unread')).toHaveCount(1)
    await page.getByTestId('activity-tab-all').click()
    await expect(button).toBeVisible()
    await expect(page.locator('[data-testid="notification-room-row"][data-unread]')).toHaveCount(2)
    if (process.env.SHOTS) for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      // the tabs' colours move with a transition: let it end before the picture
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/mark-all-${name}-${scheme}-all.png` })
    }
    await button.click()
    await expect(page.locator('[data-testid="notification-room-row"][data-unread]')).toHaveCount(0)
    await expect(button).toHaveCount(0)
    expect(sent).toEqual(mobile ? [{ tab: 'threads' }, { tab: 'all' }] : [{ tab: 'threads', only: 'rooms' }, { tab: 'all', only: 'rooms' }])
    if (process.env.SHOTS) for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      // the tabs' colours move with a transition: let it end before the picture
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/mark-all-${name}-${scheme}-after.png` })
    }
    // the page itself never scrolls sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await ctx.close()
  })
}
