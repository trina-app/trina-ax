// The phone's 대화 tab (QA TC-256: "Phone Chats tab: search rooms and messages, and see mentions and thread replies
// there"), its two steps as the row says them:
// 1. 대화: search is there (the top bar's 🔍): rooms, messages and people, nothing else, opened on that type.
// 2. A mention and a thread reply: 멘션·스레드 on top of the 대화 list opens them as a page of the 대화 tab (‹ 대화, the
//    phone's Back to the list), and each unread thing is counted once across the tabs: the rooms' on 대화, only the app's
//    own notices on 나 (and on 나's 활동 row). The whole Activity stays in 나. A computer is as it was.
// Past the first page (#530's review): 35 newer notices of the app's own and one mention. 멘션·스레드 asks the server for
// conversation rows only, and Activity's 멘션 tab reads older pages by itself; neither says "nothing here" while older
// pages are left. Settings › 알림's way to Activity (the whole count) is not on a phone.
// Each test runs in WebKit (the iPhone app's engine: phone-chats-tab.webkit.spec.ts) and Chromium (Android's:
// phone-chats-tab.spec.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { oldNav, tabButtonNow, tabMark } from './nav'
import { routeRooms, type MockRoomSpec } from './rooms-mock'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const TEAM = id(1), DM = id(2), ROOT = id(50)
const MINJUN = { id: 'minjun', name: '민준' }, SEOYEON = { id: 'seoyeon', name: '서연' }, JIHO = { id: 'jiho', name: '지호' }
/** routeRooms' one message of its first room (its id there) */
const TEAM_MESSAGE = id(900)
/** 디자인 리뷰: a mention and one more message unread, and a thread I follow with a reply; 지호's DM: one message */
const ROOMS: MockRoomSpec[] = [
  { id: TEAM, kind: 'team', name: '디자인 리뷰', peers: [MINJUN, SEOYEON], unread: 2, threads: 1, mentioned: true, ago: 5, last: '@Olga 견적서 확인 부탁해요' },
  { id: DM, kind: 'dm', name: null, peers: [JIHO], unread: 1, ago: 30, last: '점심 같이 해요' },
]
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
type Item = Record<string, unknown>
const base = (n: number, code: string, minutes: number): Item => ({ id: id(n), eventType: code, sourceId: id(n + 1000), code, createdAt: ago(minutes), readAt: null, chatId: null, link: 'room', outcome: null })
/** the Inbox: the mention and the thread reply (conversation rows), and a scheduled task's result (the app's own) */
const INBOX: Item[] = [
  { ...base(101, 'room.mention', 5), room: { id: TEAM, from: MINJUN.name, fromId: MINJUN.id, kind: 'team', name: '디자인 리뷰', reason: 'mention', message: TEAM_MESSAGE, preview: '@Olga 견적서 확인 부탁해요', count: 1, people: 1, at: ago(5) } },
  { ...base(102, 'room.dm', 10), room: { id: TEAM, from: SEOYEON.name, fromId: SEOYEON.id, thread: ROOT, kind: 'team', name: '디자인 리뷰', reason: 'reply', message: id(51), preview: '시안 두 개 올렸어요', count: 1, people: 1, at: ago(10) } },
  { id: id(103), eventType: 'schedule.success', sourceId: id(1103), code: 'schedule.success', createdAt: ago(60), readAt: null, chatId: id(500), link: 'chat', outcome: 'succeeded', schedule: { title: '주간 보고서 정리' } },
]
const HIT = { id: TEAM_MESSAGE, roomId: TEAM, threadRootId: null, authorKind: 'user', author: MINJUN, askedBy: null, markdown: false, snippet: '@Olga 견적서 확인 부탁해요', createdAt: ago(5) }

async function start(page: Page, old = false) {
  await reset(page)
  if (old) await oldNav(page)
  await routeRooms(page, ROOMS)
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  // GET /api/notifications: every unread row, and the conversation rows' part of it (the server's roomUnreadCount)
  await page.route('**/api/notifications?*', (route) => route.fulfill(json({ items: INBOX, nextCursor: null, unreadCount: 3, roomUnreadCount: 2 })))
  await page.route(/\/api\/room-messages\?/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    return route.fulfill(json(q.includes('견적') ? { items: [HIT], rooms: [{ id: TEAM, kind: 'team', name: '디자인 리뷰', peers: [MINJUN, SEOYEON], memberCount: 3 }], nextCursor: null } : { items: [], rooms: [], nextCursor: null }))
  })
  await signIn(page)
}

/** An admin's busy week: 35 notices of the app's own (a connection to sign in again), all newer than one mention; the
 * Inbox answered as the server does: newest first, 30 a page, `only=rooms` the conversation rows alone. The second
 * page comes `slow` ms late. */
async function startBusy(page: Page, slow = 0) {
  await reset(page)
  await routeRooms(page, ROOMS)
  const app: Item[] = Array.from({ length: 35 }, (_, i) => ({ id: id(200 + i), eventType: 'connection.reconnect', sourceId: id(1200 + i), code: 'connection.reconnect', createdAt: ago(1 + i * 0.01), readAt: null, chatId: null, link: 'connections', outcome: null }))
  const mention = { ...INBOX[0]!, createdAt: ago(5), room: { ...(INBOX[0]!.room as Item), at: ago(5) } }
  const asked: string[] = []
  await page.route('**/api/notifications?*', async (route) => {
    const p = new URL(route.request().url()).searchParams
    asked.push(p.toString())
    const all = p.get('only') === 'rooms' ? [mention] : [...app, mention]
    const from = Number(p.get('cursor') ?? 0), limit = Number(p.get('limit') ?? 30)
    if (from > 0 && slow) await new Promise((r) => setTimeout(r, slow))
    const next = from + limit < all.length ? String(from + limit) : null
    return route.fulfill({ json: { items: all.slice(from, from + limit), nextCursor: next, unreadCount: 36, roomUnreadCount: 1 } })
  })
  await signIn(page)
  return asked
}

const palette = (page: Page) => page.getByTestId('search-palette')
const historyLength = (page: Page) => page.evaluate(() => history.length)
/** a tab of the bar on top (나 is the Settings dialog, which has its own bar over the page's) */
/** a phone tab (the 나 list draws its own bar over the page's: the last one is the one on show) */
const tab = (page: Page, name: 'chats' | 'me') => tabButtonNow(page, name)
/** Back as the phone does it (the iOS edge swipe, Android's Back): the history's own back */
const back = (page: Page) => page.goBack({ waitUntil: 'commit' })

export function chatsTabCases() {
  // the app's service worker (WebKit) would answer the API itself, past page.route
  test.use({ serviceWorkers: 'block' })

  test.describe('a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('step 1: 대화 has search in its bar, on rooms, messages and people', async ({ page }) => {
      await start(page)
      await tab(page, 'chats').click()
      await expect(page).toHaveURL(/\/rooms$/)
      const bar = page.getByTestId('phone-topbar')
      const search = bar.getByTestId('topbar-search')
      await expect(search).toHaveAccessibleName(t['rooms.search'])
      const box = (await search.boundingBox())!
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(44)
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(44)
      // ⊕ stays, and the name stays in the middle of the bar
      await expect(bar.getByTestId('topbar-new-dm')).toBeVisible()
      const title = (await bar.getByTestId('topbar-title').boundingBox())!
      expect(Math.abs(title.x + title.width / 2 - 195)).toBeLessThanOrEqual(2)

      await search.click()
      await expect(palette(page)).toBeVisible()
      // opened on 대화: rooms, people and messages; with no text, my rooms
      await expect(palette(page).getByTestId('search-type')).toHaveText(t['search.tab.rooms'])
      const input = palette(page).getByRole('combobox')
      await expect(input).toHaveAttribute('placeholder', t['search.placeholderRooms'])
      await expect(palette(page).getByTestId('search-section-rooms').getByRole('option')).toContainText(['디자인 리뷰', '지호'])
      // a room by its name
      await input.fill('디자인')
      await expect(palette(page).getByTestId('search-section-people').getByRole('option')).toContainText(['디자인 리뷰'])
      // a person with no DM yet
      await input.fill('bob')
      await expect(palette(page).getByTestId('search-section-people').getByRole('option')).toContainText(['Bob'])
      // a message, and nothing but conversations (no AI history, projects or files)
      await input.fill('견적')
      const messages = palette(page).getByTestId('search-section-messages')
      await expect(messages.getByTestId('search-message')).toHaveCount(1)
      await expect(messages).toContainText('견적서 확인 부탁해요')
      await expect(palette(page).locator('[data-testid^="search-section-"]')).toHaveCount(1)
      // the other types are one tap away, in the type sheet
      await palette(page).getByTestId('search-type').click()
      await expect(page.getByTestId('search-type-all')).toBeVisible()
      await page.getByTestId('search-type-rooms').click()
      await expect(palette(page).getByTestId('search-type')).toHaveText(t['search.tab.rooms'])

      // the message opens its room; the phone's Back comes back to the 대화 list, search closed
      await messages.getByTestId('search-message').click()
      await expect(page).toHaveURL(new RegExp(`/rooms/${TEAM}\\?m=${TEAM_MESSAGE}$`))
      await expect(palette(page)).toHaveCount(0)
      await back(page)
      await expect(page).toHaveURL(/\/rooms$/)
      await expect(palette(page)).toHaveCount(0)
      await expect(tab(page, 'chats')).toHaveAttribute('aria-current', 'page')
    })

    test('step 2: mentions and thread replies from 대화, each unread counted once across the tabs', async ({ page }) => {
      await start(page)
      // 대화: the rooms' own count (2 + a thread + 1); 나: only the scheduled task's result, not the mention or reply again
      await expect(tabMark(page, 'chats')).toContainText('4')
      await expect(tabMark(page, 'me')).toContainText('1')
      await expect(tabMark(page, 'me')).not.toContainText('3')
      // 나's 활동 row says what the 나 tab says
      await tab(page, 'me').click()
      await expect(page.getByTestId('settings-inbox-unread')).toContainText('1')

      // 대화: 멘션·스레드 first, a dot (no second number)
      await tab(page, 'chats').click()
      await expect(page).toHaveURL(/\/rooms$/)
      const row = page.getByTestId('rooms-activity')
      await expect(row).toBeVisible()
      await expect(row).toContainText(t['feed.chats'])
      await expect(row.getByTestId('rooms-activity-unread')).toBeVisible()
      await expect(row).not.toContainText(/\d/)
      expect((await row.boundingBox())!.y).toBeLessThan((await page.getByTestId('rooms-row').first().boundingBox())!.y)

      // a page of the 대화 tab: ‹ 대화, the name 멘션·스레드, 대화 marked; the conversations only
      const before = await historyLength(page)
      await row.click()
      await expect(page).toHaveURL(/\/activity\?in=chats$/)
      await expect(page.getByTestId('topbar-title')).toHaveText(t['feed.chats'])
      await expect(page.getByTestId('topbar-back')).toHaveAccessibleName(t['tabs.backTo'].replace('{page}', t['tabs.chats']))
      await expect(tab(page, 'chats')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('tab')).toHaveCount(3)
      await expect(page.getByRole('tab')).toContainText([t['feed.tab.all'], t['feed.tab.mentions'], t['feed.tab.threads']])
      await expect(page.getByTestId('activity-tab-dms')).toHaveCount(0)
      const rows = page.getByTestId('notification-room-row')
      await expect(rows).toHaveCount(2)
      await expect(page.getByTestId('notification-chat-link')).toHaveCount(0)
      await expect(page.getByTestId('activity-tab-mentions-unread')).toBeVisible()
      await expect(page.getByTestId('activity-tab-threads-unread')).toBeVisible()
      // a tab of it is the same page: no new entry
      await page.getByTestId('activity-tab-threads').click()
      await expect(rows).toHaveCount(1)
      await expect(rows.first().getByTestId('notification-room-where')).toContainText('스레드')
      await page.getByTestId('activity-tab-mentions').click()
      await expect(rows).toHaveCount(1)
      await expect(rows.first().getByTestId('notification-room-line')).toContainText('견적서 확인 부탁해요')
      expect(await historyLength(page)).toBe(before + 1)

      // the mention opens its room; Back: 멘션·스레드, then the 대화 list
      await rows.first().click()
      await expect(page).toHaveURL(new RegExp(`/rooms/${TEAM}\\?m=${TEAM_MESSAGE}$`))
      await back(page)
      await expect(page).toHaveURL(/\/activity\?in=chats/)
      await expect(page.getByTestId('topbar-title')).toHaveText(t['feed.chats'])
      await back(page)
      await expect(page).toHaveURL(/\/rooms$/)
      await expect(page.getByTestId('rooms-activity')).toBeVisible()

      // ‹ goes to the list too
      await page.getByTestId('rooms-activity').click()
      await expect(page).toHaveURL(/\/activity\?in=chats$/)
      await page.getByTestId('topbar-back').click()
      await expect(page).toHaveURL(/\/rooms$/)
    })

    test('opened from outside, 멘션·스레드 has the 대화 list under it; the whole Activity stays in 나', async ({ page }) => {
      await start(page)
      await page.goto('/activity?in=chats')
      await expect(page.getByTestId('topbar-title')).toHaveText(t['feed.chats'])
      await expect(tab(page, 'chats')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('notification-room-row')).toHaveCount(2)
      await back(page)
      await expect(page).toHaveURL(/\/rooms$/)
      await expect(tab(page, 'chats')).toHaveAttribute('aria-current', 'page')

      // 나 › 활동: everything, the app's own notice too, with DMs; ‹ 설정
      await tab(page, 'me').click()
      await page.getByTestId('settings-inbox').click()
      await expect(page).toHaveURL(/\/activity$/)
      await expect(page.getByTestId('topbar-title')).toHaveText(t['inbox.title'])
      await expect(tab(page, 'me')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('tab')).toHaveCount(4)
      await expect(page.getByTestId('notification-room-row')).toHaveCount(2)
      await expect(page.getByTestId('notification-chat-link')).toHaveCount(1)
    })
  })

  test.describe('a phone, past the first page', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('35 newer notices of the app and one mention: 멘션·스레드 shows the mention at once, never "nothing here"', async ({ page }) => {
      const asked = await startBusy(page)
      // 나 counts the app's 35, 대화's row has its dot
      await expect(tabMark(page, 'me')).toContainText('35')
      await tab(page, 'chats').click()
      await expect(page.getByTestId('rooms-activity-unread')).toBeVisible()
      await page.getByTestId('rooms-activity').click()
      await expect(page).toHaveURL(/\/activity\?in=chats$/)
      const rows = page.getByTestId('notification-room-row')
      await expect(rows).toHaveCount(1)
      await expect(rows.first().getByTestId('notification-room-line')).toContainText('견적서 확인 부탁해요')
      await expect(page.getByText(t['feed.chatsEmpty'])).toHaveCount(0)
      await expect(page.getByTestId('notification-item').filter({ hasNot: rows })).toHaveCount(0)
      // asked for the conversation rows alone; one page was all of them
      expect(asked.some((q) => q.includes('only=rooms'))).toBe(true)
      await expect(page.getByRole('button', { name: t['common.loadMore'] })).toHaveCount(0)
    })

    test('나 › 활동 › 멘션: older pages are read by themselves until the mention shows; no "nothing here" meanwhile', async ({ page }) => {
      const asked = await startBusy(page, 1500)
      await tab(page, 'me').click()
      await page.getByTestId('settings-inbox').click()
      await expect(page).toHaveURL(/\/activity$/)
      await expect(page.getByTestId('notification-item')).toHaveCount(30)
      await page.getByTestId('activity-tab-mentions').click()
      // the second page is on its way: a skeleton, not the empty text
      await expect(page.locator('.animate-pulse').first()).toBeVisible()
      await expect(page.getByText(t['feed.emptyFiltered'])).toHaveCount(0)
      await expect(page.getByText(t['notifications.empty'])).toHaveCount(0)
      const rows = page.getByTestId('notification-room-row')
      await expect(rows).toHaveCount(1)
      await expect(page.getByText(t['feed.emptyFiltered'])).toHaveCount(0)
      expect(asked.filter((q) => q.includes('cursor=30')).length).toBeGreaterThanOrEqual(1)
      expect(asked.some((q) => q.includes('only=rooms'))).toBe(false)
    })

    test('Settings › 알림: no way to Activity with the whole count on a phone (나\'s 활동 row has the split)', async ({ page }) => {
      await startBusy(page)
      await tab(page, 'me').click()
      await expect(page.getByTestId('settings-inbox-unread')).toContainText('35')
      await page.getByTestId('settings-row-notifications').click()
      await expect(page.getByTestId('notifications')).toBeVisible()
      // its way to Activity is the computer's (hidden here); its count is the 나 tab's all the same, never the whole 36
      await expect(page.getByTestId('notifications-activity')).toBeHidden()
      await expect(page.getByTestId('notifications-activity')).toContainText('35')
      await expect(page.getByTestId('notifications')).not.toContainText('36')
    })
  })

  test.describe('a computer', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    // today's sidebar (the new navigation has the 멘션·스레드 row on computers too: chats-panel.spec.ts, rail.spec.ts)
    test('as it was: no 멘션·스레드 row, no 대화 type in search, the sidebar\'s Activity counts everything', async ({ page }) => {
      await start(page, true)
      await expect(page.getByTestId('inbox-unread')).toContainText('3')
      await page.goto('/rooms')
      await expect(page.getByTestId('rooms-row')).toHaveCount(2)
      await expect(page.getByTestId('rooms-activity')).toBeHidden()
      await page.keyboard.press('ControlOrMeta+k')
      await expect(palette(page)).toBeVisible()
      await expect(palette(page).getByRole('tab')).toHaveText(['all', 'chats', 'projects', 'files', 'skills', 'scheduled', 'mcp'].map((x) => t[`search.tab.${x}` as keyof typeof t]))
      await expect(palette(page).getByRole('combobox')).toHaveAttribute('placeholder', t['search.placeholder'])
      // Settings › 알림's way to Activity: the whole count, as the sidebar
      await page.keyboard.press('Escape')
      await page.goto('/settings/notifications')
      await expect(page.getByTestId('notifications-activity')).toBeVisible()
      await expect(page.getByTestId('notifications-activity')).toContainText('3')
    })
  })
}
