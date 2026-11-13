// Rooms and Activity changes show at once (docs/DECISIONS.md "Optimistic changes: the screen first, the server after";
// store/rooms.ts setNotifyLevel, store/inbox.ts markAllNoticesRead) at 1440 and 390 wide: a room's notification level
// shows 끄기 while the server has not answered yet, and a refusal puts the old level back with one toast; Activity's
// "Mark all as read" takes the unread marks away before the answer, and a refusal brings them back with one toast.
// The server's answers are held here (page.route) until the test lets them go; the rooms come from rooms-mock.ts.
import { expect, test, type Page, type Route } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block', locale: 'ko-KR' })

const rid = (n: number) => `019a5f00-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`
const SORA = { id: 'sora', name: '김소라' }
const MINSU = { id: 'minsu', name: '이민수' }
const GROUP = rid(1)
const ROOMS: MockRoomSpec[] = [{ id: GROUP, kind: 'group', name: '디자인 리뷰', peers: [SORA, MINSU], ago: 3, last: '시안 2차 올렸어요' }]

/** requests matching `match` wait here until `release` (fallback: the next route answers) or `refuse` (a 500) */
async function hold(page: Page, match: RegExp, method: string) {
  const held: Route[] = []
  await page.route(match, (route) => (route.request().method() === method ? void held.push(route) : route.fallback()))
  return {
    count: () => held.length,
    release: async () => { for (const r of held.splice(0)) await r.fallback() },
    refuse: async () => { for (const r of held.splice(0)) await r.fulfill({ status: 500, json: { error: { code: 'internal', message: '잠시 후 다시 시도해 주세요.' } } }) },
  }
}

const SIZES = [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const

for (const [name, viewport, phone] of SIZES) {
  test.describe(`${name} wide`, () => {
    test.use({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) })

    /** 끄기 from the room's bell (a computer) or its "⋯" › 알림 설정 (a phone) */
    async function chooseOff(page: Page) {
      if (phone) {
        await page.getByTestId('room-menu').tap()
        await page.getByTestId('room-menu-notify').tap()
        await page.getByTestId('room-notify-off').tap()
      } else {
        await page.getByTestId('room-notify').click()
        await page.getByTestId('room-notify-off').click()
      }
    }
    /** the level the room shows now: the bell's name (a computer), the "⋯" menu's 알림 설정 line (a phone) */
    async function expectLevel(page: Page, word: string) {
      if (phone) {
        await page.getByTestId('room-menu').tap()
        await expect(page.getByTestId('room-menu-notify')).toHaveText(new RegExp(`알림 설정\\s*· ${word}`))
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('room-menu-notify')).toHaveCount(0)
      } else {
        await expect(page.getByTestId('room-notify')).toHaveAttribute('aria-label', new RegExp(word))
      }
    }

    test('notification level: 끄기 shows before the server answers; a refusal puts it back with one toast', async ({ page }) => {
      await reset(page)
      const state = await routeRooms(page, ROOMS)
      const patch = await hold(page, new RegExp(`/api/rooms/${GROUP}$`), 'PATCH')
      await signIn(page)
      await page.goto(`/rooms/${GROUP}`)
      await expect(page.getByTestId('room-title')).toHaveText('디자인 리뷰')
      await expectLevel(page, '모든 메시지')

      await chooseOff(page)
      await expect.poll(() => patch.count()).toBe(1)
      // the server has not answered: the room already says 끄기
      await expectLevel(page, '끄기')
      expect(state.updated).toEqual([])
      await patch.release()
      await expect.poll(() => state.updated).toEqual([{ roomId: GROUP, body: { notifyLevel: 'off' } }])
      await expectLevel(page, '끄기')
      await expect(page.getByTestId('toast')).toHaveCount(0)

      // back to 모든 메시지, refused: 끄기 again, and one toast says so
      if (phone) {
        await page.getByTestId('room-menu').tap()
        await page.getByTestId('room-menu-notify').tap()
        await page.getByTestId('room-notify-all').tap()
      } else {
        await page.getByTestId('room-notify').click()
        await page.getByTestId('room-notify-all').click()
      }
      await expect.poll(() => patch.count()).toBe(1)
      await expectLevel(page, '모든 메시지')
      await patch.refuse()
      await expect(page.getByTestId('toast')).toHaveCount(1)
      await expect(page.getByTestId('toast')).toContainText('잠시 후 다시 시도해 주세요.')
      await expectLevel(page, '끄기')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test('Activity "Mark all as read": the unread marks go before the answer; a refusal brings them back with one toast', async ({ page }) => {
      const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
      const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
      const base = (n: number, code: string, minutes: number) => ({ id: id(n), eventType: code, sourceId: id(n + 1000), code, createdAt: ago(minutes), readAt: null as string | null, chatId: null, link: 'room', outcome: null })
      let items = [
        { ...base(1, 'room.mention', 3), room: { id: id(390), from: '민준', fromId: 'minjun', kind: 'team', name: '디자인 리뷰', reason: 'mention', message: id(590), preview: '@Olga 시안 확인 부탁해요', count: 1, people: 1, at: ago(3) } },
        { ...base(2, 'room.mention', 20), room: { id: id(391), from: '서연', fromId: 'seoyeon', kind: 'team', name: '마케팅', reason: 'everyone', message: id(591), preview: '@전체 내일 오전 회의', count: 1, people: 1, at: ago(20) } },
      ]
      await reset(page)
      await signIn(page)
      await page.route('**/api/notifications?*', (route) => route.fulfill({ json: { items, nextCursor: null, unreadCount: items.filter((x) => !x.readAt).length, roomUnreadCount: items.filter((x) => !x.readAt).length } }))
      await page.route('**/api/notifications/read', (route) => {
        items = items.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() }))
        return route.fulfill({ json: { read: 2 } })
      })
      const markAll = await hold(page, /\/api\/notifications\/read$/, 'POST')
      // a computer: the conversations' notices are 대화's 멘션·스레드 (the 활동 panel has the others: the test below)
      await page.goto(phone ? '/activity' : '/activity?in=chats')
      const unread = page.locator('[data-testid="notification-room-row"][data-unread]')
      await expect(unread).toHaveCount(2)
      const button = page.getByTestId('activity-mark-all-read')

      // refused first: the marks go at once, then come back with one toast
      await button.click()
      await expect.poll(() => markAll.count()).toBe(1)
      await expect(unread).toHaveCount(0)
      await markAll.refuse()
      await expect(page.getByTestId('toast')).toHaveCount(1)
      await expect(unread).toHaveCount(2)
      await expect(button).toBeVisible()

      // again, answered: gone before the answer, and they stay gone after it
      await button.click()
      await expect.poll(() => markAll.count()).toBe(1)
      await expect(unread).toHaveCount(0)
      await expect(button).toHaveCount(0)
      await markAll.release()
      await expect.poll(() => items.every((x) => x.readAt)).toBe(true)
      await expect(unread).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  })
}

test.describe('1440 wide, the 활동 panel', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a notice opened from the panel shows read at once; a refusal brings its dot back with one toast', async ({ page }) => {
    const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
    const notice = (n: number, minutes: number) => ({ id: id(n), eventType: 'schedule.failure', sourceId: id(n + 1000), code: 'schedule.failure', createdAt: ago(minutes), readAt: null as string | null, chatId: null, link: null, outcome: 'failed', schedule: { title: n === 1 ? '아침 요약' : '주간 보고' } })
    const items = [notice(1, 5), notice(2, 30)]
    await reset(page)
    await signIn(page)
    await page.route('**/api/notifications?*', (route) => {
      const unread = items.filter((x) => !x.readAt).length
      return route.fulfill({ json: { items, nextCursor: null, unreadCount: unread, roomUnreadCount: 0, noticeUnreadCount: unread } })
    })
    await page.route(/\/api\/notifications\/[^/?]+$/, (route) => {
      const item = items.find((x) => route.request().url().endsWith(x.id))
      return item ? route.fulfill({ json: item }) : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '' } } })
    })
    const read = await hold(page, /\/api\/notifications\/[^/]+\/read$/, 'POST')
    await page.goto('/')
    await page.getByTestId('rail-activity').click()
    const rows = page.getByTestId('activity-panel').getByTestId('activity-panel-row')
    await expect(rows).toHaveCount(2)
    await expect(page.getByTestId('activity-panel-dot')).toHaveCount(2)
    await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '2')

    await rows.first().click()
    await expect(page).toHaveURL(new RegExp(`/activity\\?n=${id(1)}$`))
    // the server has not answered: its dot and the rail's number already went down
    await expect.poll(() => read.count()).toBe(1)
    await expect(page.getByTestId('activity-panel-dot')).toHaveCount(1)
    await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '1')
    // refused (one request: the opened view does not ask again what the list asked): the dot comes back, one toast
    await read.refuse()
    await expect(page.getByTestId('toast')).toHaveCount(1)
    await expect(page.getByTestId('activity-panel-dot')).toHaveCount(2)
    await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '2')
    expect(read.count()).toBe(0)
  })
})
