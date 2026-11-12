// The Inbox's conversation rows (docs/DECISIONS.md "알림함의 대화 알림"): who and where, the newest line with an "@" for a
// mention and the unread count, one row for a thread's replies, and a click that opens the thread at my first unread
// reply (picked out and scrolled into sight) and reads the row.
// With SHOTS=1 it also takes the Inbox at 1440 and 390, light and dark, into $SHOTS_DIR (default test-results/inbox-rooms).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const MINJUN = { id: 'minjun', name: '민준' }, SEOYEON = { id: 'seoyeon', name: '서연' }, JIHO = { id: 'jiho', name: '지호' }, HAEUN = { id: 'haeun', name: '하은' }
const ROOT = id(300)
/** a thread long enough that its middle is out of sight at first */
const REPLIES: MockMessage[] = Array.from({ length: 40 }, (_, i) => ({ id: id(301 + i), author: [MINJUN, SEOYEON, JIHO][i % 3]!, body: `답글 ${i + 1}: 일정 확인 부탁드려요`, threadRootId: ROOT }))
const TARGET = REPLIES[12]!

type Item = Record<string, unknown>
const base = (n: number, code: string, minutes: number, read = false): Item => ({ id: id(n), eventType: code, sourceId: id(n + 1000), code, createdAt: ago(minutes), readAt: read ? ago(minutes - 1) : null, chatId: null, link: 'room', outcome: null })
function inbox(): Item[] {
  return [
    { ...base(1, 'room.dm', 2), room: { id: ROOM_ID, from: SEOYEON.name, fromId: SEOYEON.id, thread: ROOT, kind: 'team', name: '디자인 리뷰', reason: 'reply', message: TARGET.id, preview: '좋아요, 그럼 금요일까지 초안을 공유할게요', count: 3, people: 3, at: ago(2) } },
    { ...base(2, 'room.mention', 14), room: { id: ROOM_ID, from: MINJUN.name, fromId: MINJUN.id, kind: 'team', name: '디자인 리뷰', reason: 'mention', message: id(310), preview: '@Olga 내일 오전 회의 자료를 올려 주실 수 있을까요? 표지만 바꾸면 될 것 같아요', count: 2, people: 2, at: ago(14) } },
    { ...base(3, 'room.mention', 35, true), room: { id: id(402), from: JIHO.name, fromId: JIHO.id, kind: 'dm', name: null, reason: 'mention', message: id(311), preview: '@Olga 점심 같이 하실래요?', count: 1, people: 1, at: ago(35) } },
    { ...base(4, 'room.mention', 60, true), room: { id: id(403), from: HAEUN.name, fromId: HAEUN.id, kind: 'all', name: null, reason: 'everyone', message: id(312), preview: '@전체 다음 주 화요일은 사무실이 쉬어요', count: 1, people: 1, at: ago(60) } },
    { ...base(5, 'room.dm', 80, true), room: { id: ROOM_ID, from: null, fromId: null, ai: true, thread: ROOT, kind: 'team', name: '디자인 리뷰', reason: 'reply', message: id(313), preview: '**요약**: 이번 주 안에 시안 두 개를 정리하면 돼요', count: 1, people: 1, at: ago(80) } },
    { id: id(6), eventType: 'schedule.success', sourceId: id(1006), code: 'schedule.success', createdAt: ago(120), readAt: null, chatId: id(500), link: 'chat', outcome: 'succeeded', schedule: { title: '주간 보고서 정리' } },
  ]
}

async function routeInbox(page: Page) {
  const state = { reads: [] as string[], items: inbox() }
  const unread = () => state.items.filter((x) => !x.readAt).length
  await page.route('**/api/notifications?*', (route) => route.fulfill({ json: { items: state.items, nextCursor: null, unreadCount: unread() } }))
  await page.route('**/api/notifications/*/read', (route) => {
    const nid = new URL(route.request().url()).pathname.split('/')[3]!
    state.reads.push(nid)
    state.items = state.items.map((x) => (x.id === nid ? { ...x, readAt: new Date().toISOString() } : x))
    return route.fulfill({ json: state.items.find((x) => x.id === nid) })
  })
  return state
}

async function routeThread(page: Page) {
  return routeRoom(page, { kind: 'team', members: [MINJUN, SEOYEON, JIHO], messages: [{ id: ROOT, author: MINJUN, body: '다음 주 발표 시안, 어떻게 나눌까요?' }, ...REPLIES] })
}

test('a thread row says who and where with the newest line and the count; a click opens the thread at the first unread reply and reads it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const state = await routeInbox(page)
  await routeThread(page)
  await page.goto('/activity')
  const rows = page.getByTestId('notification-room-row')
  await expect(rows).toHaveCount(5)
  const first = rows.first()
  await expect(first.getByTestId('notification-room-who')).toHaveText('서연 외 2명')
  await expect(first.getByTestId('notification-room-where')).toContainText('#디자인 리뷰 › 스레드')
  await expect(first.getByTestId('notification-room-line')).toHaveText('좋아요, 그럼 금요일까지 초안을 공유할게요')
  await expect(first.getByTestId('notification-room-count')).toContainText('3')
  await expect(first).toHaveAttribute('data-unread', '')
  // the others: the timeline's mentions (two people), a DM's mention, "@전체" and the AI's answer, each place its row
  await expect(rows.nth(1).getByTestId('notification-room-who')).toHaveText('민준 외 1명')
  await expect(rows.nth(1).getByTestId('notification-room-line')).toHaveText('@멘션: @Olga 내일 오전 회의 자료를 올려 주실 수 있을까요? 표지만 바꾸면 될 것 같아요')
  await expect(rows.nth(2).getByTestId('notification-room-where')).toContainText('1:1')
  await expect(rows.nth(2).getByTestId('notification-room-count')).toHaveCount(0)
  await expect(rows.nth(3).getByTestId('notification-room-line')).toHaveText('@@전체: @전체 다음 주 화요일은 사무실이 쉬어요')
  await expect(rows.nth(4).getByTestId('notification-room-who')).toHaveText('트리나')
  await expect(rows.nth(4).getByTestId('notification-room-line')).toHaveText('요약: 이번 주 안에 시안 두 개를 정리하면 돼요')
  // a scheduled run's row reads like them: the task by name, the time on the right, the whole row opens its result
  // (no "결과 열기" under it, no date line); keyboard: one link with that name
  const run = page.getByTestId('notification-chat-link')
  await expect(run).toHaveAttribute('href', `/c/${id(500)}`)
  await expect(run.getByTestId('notification-text')).toHaveText('"주간 보고서 정리" 예약 작업이 끝났어요.')
  await expect(run.locator('time')).toBeVisible()
  await expect(page.getByTestId('activity')).not.toContainText('결과 열기')
  await expect(page.getByRole('link', { name: /주간 보고서 정리/ })).toHaveCount(1)
  // Activity reads like Slack's: the time right after the name, on the first line, in every row
  const box = (await run.boundingBox())!, time = (await run.locator('time').boundingBox())!
  const firstBox = (await first.boundingBox())!, rowTime = (await first.locator('time').boundingBox())!
  expect(time.y - box.y).toBeLessThan(24)
  expect(rowTime.y - firstBox.y).toBeLessThan(24)
  // the click: the thread, the reply in the middle of it picked out and in sight, the notice read
  await first.click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${ROOT}\\?m=${TARGET.id}$`))
  const picked = page.getByTestId('room-thread').locator('[data-highlight]')
  await expect(picked).toContainText(TARGET.body)
  await expect(picked).toBeInViewport()
  expect(state.reads).toEqual([id(1)])
})

test('Inbox screenshots: 1440 and 390, light and dark', async ({ browser }) => {
  test.skip(!process.env.SHOTS, 'only with SHOTS=1')
  const dir = process.env.SHOTS_DIR ?? 'test-results/inbox-rooms'
  for (const [name, viewport, mobile] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, locale: 'ko-KR', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { deviceScaleFactor: 1 }) })
      const page = await ctx.newPage()
      await reset(page)
      await signIn(page)
      await routeInbox(page)
      await routeThread(page)
      await page.goto('/activity')
      await expect(page.getByTestId('notification-room-row')).toHaveCount(5)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/inbox-${name}-${scheme}.png` })
      await page.getByTestId('notification-room-row').first().click()
      await expect(page.getByTestId('room-thread').locator('[data-highlight]')).toBeVisible()
      await page.screenshot({ path: `${dir}/thread-${name}-${scheme}.png` })
      await ctx.close()
    }
  }
})
