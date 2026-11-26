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
import { tabButton, tabMark } from './nav'
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

async function start(page: Page) {
  await reset(page)
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
const tab = (page: Page, name: 'chats' | 'me') => tabButton(page, name)
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

    test('step 2: mentions and thread replies are in 나 › 활동, the one Activity; 대화 counts its rooms, 나 every notice', async ({ page }) => {
      await start(page)
      // 대화: how many conversations have something unread (the rail's one number, rail/railBadges.ts chatsMark: 디자인
      // 리뷰 and 지호's DM); 나: every unread notice, the mention and the reply with the scheduled task's result
      await expect(tabMark(page, 'chats')).toContainText('2')
      await expect(tabMark(page, 'me')).toContainText('3')
      // 나's 활동 row says what the 나 tab says
      await tab(page, 'me').click()
      await expect(page.getByTestId('settings-inbox-unread')).toContainText('3')

      // 대화: no 멘션·스레드 row, the rooms first
      await tab(page, 'chats').click()
      await expect(page).toHaveURL(/\/rooms$/)
      await expect(page.getByTestId('rooms-row').first()).toBeVisible()
      await expect(page.getByTestId('rooms-activity')).toHaveCount(0)

      // 나 › 활동: ‹ 설정, 나 marked, All · DM · Mentions · Threads
      await tab(page, 'me').click()
      await page.getByTestId('settings-inbox').click()
      await expect(page).toHaveURL(/\/activity$/)
      await expect(page.getByTestId('topbar-title')).toHaveText(t['inbox.title'])
      await expect(tab(page, 'me')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('tab')).toHaveCount(4)
      const rows = page.getByTestId('notification-room-row')
      await expect(rows).toHaveCount(2)
      await expect(page.getByTestId('activity-tab-mentions-unread')).toBeVisible()
      await expect(page.getByTestId('activity-tab-threads-unread')).toBeVisible()
      const before = await historyLength(page)
      // a tab of it is the same page: no new entry
      await page.getByTestId('activity-tab-threads').click()
      await expect(rows).toHaveCount(1)
      await expect(rows.first().getByTestId('notification-room-where')).toContainText('스레드')
      await page.getByTestId('activity-tab-mentions').click()
      await expect(rows).toHaveCount(1)
      await expect(rows.first().getByTestId('notification-room-line')).toContainText('견적서 확인 부탁해요')
      expect(await historyLength(page)).toBe(before)

      // the mention opens its room; Back: 활동
      await rows.first().click()
      await expect(page).toHaveURL(new RegExp(`/rooms/${TEAM}\\?m=${TEAM_MESSAGE}$`))
      await back(page)
      await expect(page).toHaveURL(/\/activity/)
      await expect(page.getByTestId('topbar-title')).toHaveText(t['inbox.title'])
    })

    test('an old 멘션·스레드 link (?in=chats) opens the one Activity in 나, its tab kept, never a 404', async ({ page }) => {
      await start(page)
      await page.goto('/activity?in=chats')
      await expect(page).toHaveURL(/\/activity$/)
      await expect(page.getByTestId('topbar-title')).toHaveText(t['inbox.title'])
      await expect(tab(page, 'me')).toHaveAttribute('aria-current', 'page')
      // everything, the app's own notice too, with DMs
      await expect(page.getByRole('tab')).toHaveCount(4)
      await expect(page.getByTestId('notification-room-row')).toHaveCount(2)
      await expect(page.getByTestId('notification-chat-link')).toHaveCount(1)
      await page.goto('/activity?in=chats&tab=threads')
      await expect(page).toHaveURL(/\/activity\?tab=threads$/)
      await expect(page.getByTestId('activity-tab-threads')).toHaveAttribute('aria-selected', 'true')
    })
  })

  test.describe('a phone, a message in Markdown', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('the list\'s preview is its plain words: no ** * ` marks (the room shows them bold, slanted, as code)', async ({ page }) => {
      await reset(page)
      await routeRooms(page, [{ id: DM, kind: 'dm', name: null, peers: [JIHO], ago: 3, last: '**굵게** *기울임* `코드` 확인해 주세요' }])
      await signIn(page)
      await tab(page, 'chats').click()
      const row = page.getByTestId('rooms-row').filter({ hasText: '지호' })
      await expect(row).toContainText('굵게 기울임 코드 확인해 주세요')
      await expect(row).not.toContainText('*')
      await expect(row).not.toContainText('`')
    })
  })

  test.describe('a phone, past the first page', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('35 newer notices of the app and one mention: 나 counts all 36; no 멘션·스레드 row on 대화', async ({ page }) => {
      await startBusy(page)
      await expect(tabMark(page, 'me')).toContainText('36')
      await tab(page, 'chats').click()
      await expect(page.getByTestId('rooms-activity')).toHaveCount(0)
      await expect(page.getByTestId('rooms-activity-unread')).toHaveCount(0)
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
      // the page reads every notice (store/chatMentions.ts reads only=rooms on its own)
      expect(asked.some((q) => q.includes('cursor=30') && !q.includes('only='))).toBe(true)
    })

    test('Settings › 알림: no way to Activity on a phone; its count is the 나 tab\'s, every notice (the one Activity)', async ({ page }) => {
      await startBusy(page)
      await tab(page, 'me').click()
      await expect(page.getByTestId('settings-inbox-unread')).toContainText('36')
      await page.getByTestId('settings-row-notifications').click()
      await expect(page.getByTestId('notifications')).toBeVisible()
      // its way to Activity is the computer's (hidden here); its count is the 나 tab's all the same
      await expect(page.getByTestId('notifications-activity')).toBeHidden()
      await expect(page.getByTestId('notifications-activity')).toContainText('36')
    })
  })

  test.describe('a phone, long names and counts', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })

    // QA TC-4833: the 대화 list dragged sideways (the section header's ⊕ took taps from a 44 px box that stuck 2 px out
    // of the list, so the list was 392 px wide on a 390 px phone). No phone tab is wider than the screen, with long
    // names and counts too, and a swipe on the 대화 list (a thumb drifts sideways) leaves it where it was across.
    test('no tab is wider than the phone, and the 대화 list never moves sideways (TC-4833)', async ({ page, browserName }) => {
      const LONG = '아주아주긴방이름입니다한줄에절대로들어가지않는그런방이름예시예요 An-extremely-long-room-name-without-any-spaces-at-all'
      await reset(page)
      await routeRooms(page, [
        ...ROOMS,
        { id: id(60), kind: 'group', name: LONG, peers: [MINJUN, SEOYEON], unread: 999, mentioned: true, ago: 1, last: LONG + LONG },
        { id: id(61), kind: 'team', name: LONG, peers: [JIHO], unread: 120, threads: 3, muted: true, ago: 2, last: LONG },
        { id: id(62), kind: 'group', name: null, peers: [{ id: 'long', name: LONG }, JIHO], unread: 88, pinnedAt: ago(1), ago: 3, last: LONG },
      ])
      await signIn(page)
      /** the page and every box that scrolls sideways (not the message box or a row of tabs meant to scroll): wider than shown */
      const wider = () => page.evaluate(() => {
        const de = document.documentElement
        const boxes = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
          const ox = getComputedStyle(el).overflowX
          return (ox === 'auto' || ox === 'scroll') && el.tagName !== 'TEXTAREA' && !el.closest('.edge-fade') && el.scrollWidth > el.clientWidth
        })
        return [...(de.scrollWidth > de.clientWidth ? [`page ${de.scrollWidth}/${de.clientWidth}`] : []), ...boxes.map((el) => `${el.dataset.testid ?? el.tagName} ${el.scrollWidth}/${el.clientWidth}`)]
      })
      for (const width of [360, 390, 430]) {
        await page.setViewportSize({ width, height: 844 })
        for (const path of ['/', '/rooms', '/projects', '/files', '/activity']) {
          await page.goto(path)
          if (path === '/rooms') await expect(page.getByTestId('rooms-row').first()).toBeVisible()
          await expect.poll(wider, { message: `${path} at ${width}` }).toEqual([])
        }
      }
      // the swipe: up the list while drifting sideways, then mostly sideways (Chromium: a touch gesture; mobile WebKit
      // takes neither a touch gesture nor a wheel from Playwright: the same scroll asked of the list)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto('/rooms')
      const list = page.getByTestId('rooms-page')
      await expect(page.getByTestId('rooms-row').first()).toBeVisible()
      const across = () => list.evaluate((el) => ({ list: el.scrollLeft, page: window.scrollX }))
      for (const [x, y] of [[-60, -300], [-150, -20]] as const) {
        if (browserName === 'chromium') {
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 500, xDistance: x, yDistance: y, gestureSourceType: 'touch', speed: 800 })
        } else {
          await list.evaluate((el, [dx, dy]) => el.scrollBy({ left: dx, top: dy, behavior: 'instant' }), [-x, -y])
        }
        await page.waitForTimeout(300)
        expect(await across()).toEqual({ list: 0, page: 0 })
      }
      // and nothing to scroll to: set by hand, it stays at 0
      expect(await list.evaluate((el) => { el.scrollLeft = 50; return el.scrollLeft })).toBe(0)
    })
  })
}
