// A conversation at "Mentions only" adds no number (docs/decisions/20261116-mentions-only-no-count.md, QA TC-4171): plain
// messages make its row bold with no badge, put nothing on its folded folder or the rail's 대화 (nor the phone's 대화
// tab); a message that mentions me shows "@" there and counts 1. The rooms come from the mock's /__test/rooms, each set
// sent like the server's room.updated after a message.
// With SHOTS=1 it also takes the list at 1440 and 390, light and dark, into $SHOTS_DIR (default
// test-results/mentions-only-count).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const CHANNEL = uuidv7(), DM = uuidv7(), MUTED = uuidv7(), TEAM = uuidv7()
const level = (l: 'all' | 'mentions' | 'off', own = true) => ({ own: own ? l : null, byDefault: own ? 'all' : l, level: l })
const room = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, kind: 'group', name, groupId: null, memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, ...o,
})
/** the app channel set to "Mentions only", with `n` plain messages unread (and a mention when `mentioned`) */
let folderId: string | null = null
const checkins = (n: number, mentioned = false) => room(CHANNEL, 'Daily Checkins', { unreadCount: n, lastSeq: n, mentioned, notify: level('mentions'), activityAt: ago(1), ...(folderId ? { folderId } : {}) })
const setRooms = async (page: Page, rooms: unknown[]) => expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()

async function inFolder(page: Page, roomId: string, name: string) {
  const headers = { [CSRF_HEADER]: '1' }
  const f = await page.request.post('/api/nav-folders', { headers, data: { kind: 'rooms', name } })
  expect(f.ok()).toBeTruthy()
  const { id } = (await f.json()) as { id: string }
  expect((await page.request.put(`/api/rooms/${roomId}/folder`, { headers, data: { folderId: id } })).ok()).toBeTruthy()
  return id
}

test('mentions only: 3 plain messages make the row and its folder bold with no number and nothing on the rail; a mention shows "@" and counts 1', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  folderId = null
  await setRooms(page, [checkins(0)])
  folderId = await inFolder(page, CHANNEL, '앱')
  await setRooms(page, [checkins(0)])
  await page.getByTestId('rail-chats').click()
  const cp = page.getByTestId('chats-panel')
  const folder = cp.getByTestId('room-folder')
  const row = folder.getByTestId('sidebar-room-row').filter({ hasText: 'Daily Checkins' })
  await expect(row).toHaveCount(1)
  // three plain messages, one after another
  for (const n of [1, 2, 3]) await setRooms(page, [checkins(n)])
  await expect(row.getByTestId('sidebar-room')).toHaveClass(/font-semibold/)
  await expect(row.getByTestId('room-unread')).toHaveCount(0)
  // a screen reader still hears that something is unread
  await expect(row.getByTestId('room-unread-bold')).toHaveText(t['rooms.unreadNoCount'])
  await expect(page.getByTestId('rail-chats-mark')).toHaveCount(0)
  // folded: bold, no pill
  await folder.getByTestId('room-folder-fold').click()
  await expect(folder.getByTestId('room-folder-fold')).toHaveAttribute('aria-expanded', 'false')
  await expect(folder.getByTestId('room-folder-fold')).toHaveClass(/font-bold/)
  await expect(folder.getByTestId('room-folder-pill')).toHaveCount(0)
  // a message that mentions me: "@" on the folder and the row, 1 on the rail
  await setRooms(page, [checkins(4, true)])
  await expect(folder.getByTestId('room-folder-pill')).toHaveAttribute('data-kind', 'mention')
  await expect(page.getByTestId('rail-chats-mark')).toHaveAttribute('data-n', '1')
  await folder.getByTestId('room-folder-fold').click()
  await expect(row.getByTestId('room-unread')).toHaveText(`@${t['rooms.unread'].replace('{n}', '4')}, ${t['rooms.mentionedYou']}`)
})

test("the phone's 대화 tab: no number for a mentions-only room's plain messages, 1 once one mentions me", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  folderId = null
  await reset(page)
  await signIn(page)
  await setRooms(page, [checkins(3)])
  await page.goto('/rooms')
  const row = page.getByTestId('rooms-row').filter({ hasText: 'Daily Checkins' })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('rooms-row-unread')).toHaveCount(0)
  await expect(page.getByTestId('tab-chats-unread')).toHaveCount(0)
  await setRooms(page, [checkins(4, true)])
  await expect(row.getByTestId('rooms-row-unread')).toContainText('@')
  await expect(page.getByTestId('tab-chats-unread')).toContainText('1')
})

test('mentions only screenshots: 1440 and 390, light and dark', async ({ browser }) => {
  test.skip(!process.env.SHOTS, 'only with SHOTS=1')
  const dir = process.env.SHOTS_DIR ?? 'test-results/mentions-only-count'
  folderId = null
  const rooms = [
    checkins(3),
    room(DM, null as never, { kind: 'dm', unreadCount: 2, lastSeq: 2, notify: level('all', false), activityAt: ago(2) }),
    room(TEAM, '디자인 리뷰', { kind: 'team', groupId: uuidv7(), unreadCount: 5, lastSeq: 5, mentioned: true, notify: level('mentions', false), activityAt: ago(3) }),
    room(MUTED, '점심 메뉴', { unreadCount: 7, lastSeq: 7, muted: true, notify: level('off'), activityAt: ago(4) }),
  ]
  for (const [name, viewport, mobile] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, locale: 'ko-KR', ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { deviceScaleFactor: 1 }) })
      const page = await ctx.newPage()
      await reset(page)
      await signIn(page)
      await setRooms(page, rooms)
      if (mobile) await page.goto('/rooms')
      else await page.getByTestId('rail-chats').click()
      await expect(page.getByText('Daily Checkins').first()).toBeVisible()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/rooms-${name}-${scheme}.png` })
      await ctx.close()
    }
  }
})
