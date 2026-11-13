// Activity's tabs (web/src/pages/Activity.tsx): every tab keeps the page where it is. The column is measured on each
// tab at 1440 and 390 wide, with a long list under All (the page scrolls) and a short one under Mentions (it does not):
// the tabs and the first row start at the same x on every tab. The tab's focus ring is inside the tab, so the tab
// list's scroll box does not cut it. With SHOTS=1 it also saves each tab into $SHOTS_DIR (default test-results/activity-tabs).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const PEOPLE = [{ id: 'minjun', name: '민준' }, { id: 'seoyeon', name: '서연' }, { id: 'jiho', name: '지호' }]

type Item = Record<string, unknown>
const base = (n: number, code: string, minutes: number): Item => ({ id: id(n), eventType: code, sourceId: id(n + 1000), code, createdAt: ago(minutes), readAt: null, chatId: null, link: 'room', outcome: null })
/** 24 direct messages (All and DMs scroll) and two mentions (Mentions does not) */
function inbox(): Item[] {
  const dms = Array.from({ length: 24 }, (_, i) => {
    const who = PEOPLE[i % 3]!
    return { ...base(10 + i, 'room.dm', 5 + i * 7), room: { id: id(400 + i), from: who.name, fromId: who.id, kind: 'dm', name: null, reason: 'message', message: id(600 + i), preview: `회의 자료 ${i + 1}번 확인 부탁드려요`, count: 1, people: 1, at: ago(5 + i * 7) } }
  })
  const mentions = [
    { ...base(1, 'room.mention', 3), room: { id: id(390), from: '민준', fromId: 'minjun', kind: 'team', name: '디자인 리뷰', reason: 'mention', message: id(590), preview: '@Olga https://example.com/a/very/long/link/that/does/not/break/anywhere/because/it/has/no/spaces/at/all/0123456789abcdef', count: 2, people: 1, at: ago(3) } },
    { ...base(2, 'room.mention', 40), room: { id: id(391), from: '지호', fromId: 'jiho', kind: 'team', name: '마케팅', reason: 'mention', message: id(591), preview: '@Olga 내일 오전 회의 자료를 올려 주실 수 있을까요?', count: 1, people: 1, at: ago(40) } },
  ]
  return [...mentions, ...dms]
}
async function routeInbox(page: Page) {
  const items = inbox()
  await page.route('**/api/notifications?*', (route) => route.fulfill({ json: { items, nextCursor: null, unreadCount: items.length } }))
}

// scroll bars that take room, as on Windows or a Mac with a mouse (headless Chromium hides them by default)
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

const TABS = ['all', 'dms', 'mentions', 'threads'] as const
const SIZES = [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const

for (const [name, viewport, mobile] of SIZES) {
  test(`${name} wide: every tab keeps the tabs and the list at the same x`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, locale: 'ko-KR', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
    const page = await ctx.newPage()
    await reset(page)
    await signIn(page)
    await routeInbox(page)
    await page.goto('/activity')
    await expect(page.getByTestId('notification-item').first()).toBeVisible()
    // scroll bars that take room, as on Windows or a Mac with a mouse (with the launch option above; CSSOM, since the
    // page's CSP refuses a style tag)
    await page.evaluate(() => {
      const sheet = [...document.styleSheets].find((x) => { try { return !!x.cssRules } catch { return false } })!
      sheet.insertRule('::-webkit-scrollbar { width: 15px; height: 15px }', sheet.cssRules.length)
      sheet.insertRule('::-webkit-scrollbar-thumb { background: #999 }', sheet.cssRules.length)
    })
    // where the tab list, the tools under it and each tab start, and how wide the column is
    const where = async () => {
      const box = async (testId: string) => { const b = (await page.getByTestId(testId).first().boundingBox())!; return [Math.round(b.x), Math.round(b.width)] }
      const tabs: number[] = []
      for (const t of TABS) tabs.push((await box(`activity-tab-${t}`))[0]!)
      return { list: await box('activity-tabs'), tools: await box('activity-tools'), tabs }
    }
    const seen: Record<string, unknown> = {}
    for (const tab of TABS) {
      await page.getByTestId(`activity-tab-${tab}`).click()
      await expect(page.getByTestId(`activity-tab-${tab}`)).toHaveAttribute('aria-selected', 'true')
      if (tab === 'threads') await expect(page.getByTestId('notification-item')).toHaveCount(0)
      else await expect(page.getByTestId('notification-item').first()).toBeVisible()
      seen[tab] = await where()
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/activity-tabs'}/activity-${name}-${tab}.png` })
    }
    for (const tab of TABS) expect({ tab, ...(seen[tab] as object) }).toEqual({ tab, ...(seen.all as object) })
    // a click shows no ring (index.css draws it for keyboard focus only)
    expect(await page.getByTestId('activity-tab-threads').evaluate((e) => e === document.activeElement && !e.matches(':focus-visible'))).toBe(true)
    // keyboard focus on a tab: its ring is drawn inside it, where the tab list's scroll box does not cut it
    await page.getByTestId('activity-tab-mentions').focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    const ring = await page.getByTestId('activity-tab-mentions').evaluate((e) => { const s = getComputedStyle(e); return { style: s.outlineStyle, offset: parseFloat(s.outlineOffset), width: parseFloat(s.outlineWidth) } })
    expect(ring.style).toBe('solid')
    expect(ring.offset + ring.width).toBeLessThanOrEqual(0)
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/activity-tabs'}/activity-${name}-focus.png` })
    // the page itself never scrolls sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await ctx.close()
  })
}
