// A file shared with me that no longer opens, in 활동 (docs/decisions/20261120-file-share-gone-notice.md, QA TC-5664),
// at 1440 and 390 wide: the line names who shared it and why (never the file), the row is muted and opens nothing, and
// a read one is not in the list (the server leaves it out). With SHOTS=1 it saves the list and the notice's own view
// into $SHOTS_DIR (default test-results/file-share-gone-notice).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const base = (n: number, minutes: number, readAt: string | null) => ({ id: id(n), eventType: 'file.shared', sourceId: id(n + 1000), code: 'file.shared', createdAt: ago(minutes), readAt, chatId: null, outcome: null })
const GONE = { ...base(1, 5, null), link: null, fileShare: { by: 'test', name: null, linkId: null, gone: true, why: 'stopped' } }
const LIVE = { ...base(2, 30, null), link: 'file', fileShare: { by: '민준', name: '견적서.xlsx', linkId: 'AAAAAAAAAAAAAAAAAAAAAA' } }
// the server leaves a read gone one out of the list (notifications/service.ts list); BEFORE=1 lists it as dev did
const READ_GONE = { ...base(3, 90, ago(60)), link: null, fileShare: { by: 'test', name: null, linkId: null, gone: true, why: 'deleted' } }
const before = !!process.env.BEFORE

async function route(page: Page) {
  const items = before ? [GONE, LIVE, READ_GONE] : [GONE, LIVE]
  const list = { items, nextCursor: null, unreadCount: 2, roomUnreadCount: 0, noticeUnreadCount: 2 }
  await page.route((u) => u.pathname === '/api/notifications', (r) => r.fulfill({ json: list }))
  await page.route((u) => u.pathname.startsWith('/api/notifications/019a5f00'), (r) => r.fulfill({ json: { ...GONE, readAt: ago(0) } }))
}

const SIZES = [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const
const dir = process.env.SHOTS_DIR ?? 'test-results/file-share-gone-notice'
const tag = before ? 'before' : 'after'

for (const [name, viewport, mobile] of SIZES) {
  test(`${name} wide: a gone share notice says who and why, muted, opens nothing`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, locale: 'ko-KR', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
    const page = await ctx.newPage()
    await reset(page)
    await signIn(page)
    await route(page)
    await page.goto('/activity')
    const want = 'test님이 공유한 파일을 이제 열 수 없어요. 공유가 중지됐어요.'
    const texts = page.getByTestId(mobile ? 'notification-text' : 'activity-panel-text')
    await expect(texts.first()).toBeVisible()
    if (!before) {
      await expect(texts.first()).toHaveText(want)
      await expect(texts).toHaveCount(2)
      await expect(page.getByText('견적서.xlsx', { exact: false }).first()).toBeVisible()
      if (!mobile) {
        const row = page.locator('[data-gone]')
        await expect(row).toHaveCount(1)
        // a button that only reads it, never a link
        expect(await row.evaluate((el) => el.tagName)).toBe('BUTTON')
      } else {
        const item = page.getByTestId('notification-item').filter({ hasText: want })
        await expect(item.locator('a')).toHaveCount(0)
      }
    }
    if (process.env.SHOTS) await page.screenshot({ path: `${dir}/${tag}-list-${name}.png` })
    // the notice's own view (what a push opens): the same words, nothing to open
    await page.goto(`/activity?n=${encodeURIComponent(GONE.id)}`)
    await expect(page.getByTestId('notification-text').first()).toBeVisible()
    if (!before) await expect(page.getByTestId('notification-text').first()).toHaveText(want)
    if (process.env.SHOTS) await page.screenshot({ path: `${dir}/${tag}-detail-${name}.png` })
    await ctx.close()
  })
}
