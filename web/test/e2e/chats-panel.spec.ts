// 대화 beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P3), with the server's `navRail` switch on:
// every conversation, no "더 보기" cap, by kind: 고정 · 팀 대화방 (전체 first) · 그룹 대화 · 1:1 대화; the rooms I hid are
// behind one quiet row; 300 rooms are all listed, drawn 200 at a time as the list scrolls (the plan's rendering budget);
// and on a narrow window (below 812 px) a room's thread is a sheet over the room.
import { expect, test, type Page } from '@playwright/test'
import { navRail, reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, routeRooms, type MockRoomSpec } from './rooms-mock'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const kid = (n: number) => `019a5f00-0000-7000-8000-${String(700 + n).padStart(12, '0')}`
const SAM = { id: 'sam', name: 'Sam' }, KIM = { id: 'kim', name: '김민지' }, EVE = { id: 'eve', name: 'Eve' }

const BY_KIND: MockRoomSpec[] = [
  { id: kid(1), kind: 'team', name: '디자인', peers: [SAM], ago: 1, last: '시안 올렸어요' },
  { id: kid(2), kind: 'dm', name: null, peers: [SAM], ago: 2, last: '내일 봬요', unread: 2 },
  { id: kid(3), kind: 'group', name: '주간회의', peers: [SAM, KIM], ago: 3, last: '안건 정리했어요' },
  { id: kid(4), kind: 'team', name: '개발', peers: [KIM], ago: 4, last: '배포 끝났어요' },
  { id: kid(5), kind: 'dm', name: null, peers: [KIM], ago: 5, last: '확인했어요', pinnedAt: '2026-11-07T08:00:00.000Z' },
  { id: kid(6), kind: 'all', name: null, peers: [SAM, KIM, EVE], ago: 6, last: '점심 같이 하실 분' },
  { id: kid(7), kind: 'team', name: '영업', peers: [EVE], ago: 7, last: '견적서 보냈어요' },
  { id: kid(8), kind: 'group', name: '점심 모임', peers: [EVE, KIM], ago: 8, last: '12시에 봬요' },
  { id: kid(9), kind: 'dm', name: null, peers: [EVE], ago: 9, last: '좋아요' },
  { id: kid(10), kind: 'team', name: '기획', peers: [EVE], ago: 10, last: '일정 공유해요' },
  { id: kid(11), kind: 'dm', name: null, peers: [{ id: 'dana', name: 'Dana' }], ago: 11, last: '감사해요', hidden: true },
]

async function start(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 860 })
  await reset(page)
  await navRail(page)
  await signIn(page)
}
const panel = (page: Page) => page.getByTestId('chats-panel')
const sectionNames = (page: Page) => panel(page).getByTestId('chats-panel-section').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))
const namesIn = (page: Page, section: string) => panel(page).locator(`[data-testid="sidebar-room-row"][data-section="${section}"] span[title]`).evaluateAll((els) => els.map((e) => e.getAttribute('title')))

test('every conversation by kind, no "더 보기"; the hidden ones behind one row', async ({ page }) => {
  await routeRooms(page, BY_KIND)
  await start(page)
  await page.getByTestId('rail-chats').click()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByTestId('sidebar-room-row')).toHaveCount(10)
  expect(await sectionNames(page)).toEqual(['pinned', 'team', 'group', 'dm'])
  await expect(panel(page).getByTestId('chats-panel-label')).toHaveText([t['chat.pinned'], t['rooms.section.team'], t['rooms.section.group'], t['rooms.section.dm']])
  expect(await namesIn(page, 'pinned')).toEqual(['김민지'])
  expect(await namesIn(page, 'team')).toEqual(['전체', '개발', '기획', '디자인', '영업'])
  expect(await namesIn(page, 'group')).toEqual(['주간회의', '점심 모임'])
  expect(await namesIn(page, 'dm')).toEqual(['Sam', 'Eve'])
  await expect(panel(page).getByTestId('rooms-more')).toHaveCount(0)
  await expect(panel(page).getByTestId('rooms-all')).toHaveCount(0)
  // 멘션·스레드 stays the first row
  await expect(panel(page).getByTestId('rooms-activity')).toBeVisible()
  // the hidden DM: on the conversations page itself it is listed there (no second row); in a room, one row at the end
  // goes there
  await expect(page.getByTestId('rooms-hidden')).toBeVisible()
  await expect(panel(page).getByTestId('chats-panel-hidden')).toHaveCount(0)
  await panel(page).getByTestId('sidebar-room').first().click()
  await expect(panel(page).getByTestId('chats-panel-hidden')).toHaveText(t['rooms.hidden.title'].replace('{n}', '1'))
  await panel(page).getByTestId('chats-panel-hidden').click()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(page.getByTestId('rooms-hidden')).toBeVisible()
})

test('300 conversations: all listed, 200 drawn at first, the rest as the list scrolls', async ({ page }) => {
  const many: MockRoomSpec[] = Array.from({ length: 300 }, (_, i) => ({ id: kid(100 + i), kind: 'dm', name: null, peers: [{ id: `p${i}`, name: `사람 ${i + 1}` }], ago: i + 1, last: '안녕하세요' }))
  await routeRooms(page, many)
  await start(page)
  const t0 = Date.now()
  await page.getByTestId('rail-chats').click()
  const list = panel(page).getByTestId('sidebar-rooms-list')
  await expect(list).toHaveAttribute('data-rooms', '300')
  await expect(list).toHaveAttribute('data-drawn', '200')
  // a cheap first draw (the budget: well under a second on a CI machine)
  expect(Date.now() - t0).toBeLessThan(5000)
  await expect(panel(page).getByTestId('sidebar-room-row')).toHaveCount(200)
  // to the end of the list: the rest are drawn
  await panel(page).getByTestId('panel-scroll').evaluate((e) => e.scrollTo(0, e.scrollHeight))
  await expect(list).toHaveAttribute('data-drawn', '300')
  await expect(panel(page).getByTestId('sidebar-room-row')).toHaveCount(300)
  await expect(panel(page).getByTestId('sidebar-room-row').last()).toContainText('사람 300')
})

const ROOT = '019a5f00-0000-7000-8000-000000000300'
async function roomWithThread(page: Page) {
  await routeRoom(page, {
    kind: 'team', members: [SAM, KIM],
    messages: [{ id: ROOT, author: SAM, body: '다음 주 발표 시안, 어떻게 나눌까요?' }, { id: '019a5f00-0000-7000-8000-000000000301', author: KIM, body: '제가 표지를 맡을게요', threadRootId: ROOT }],
  })
}

test('800 px: a thread is a sheet over the room; 1024 px: beside it', async ({ page }) => {
  await roomWithThread(page)
  await start(page, 800)
  await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
  const thread = page.getByTestId('room-thread')
  await expect(thread).toBeVisible()
  await expect(thread).toHaveAttribute('data-sheet', '')
  const room = (await page.getByTestId('room-page').boundingBox())!
  const sheet = (await thread.boundingBox())!
  expect(Math.round(sheet.x)).toBe(Math.round(room.x))
  expect(Math.round(sheet.width)).toBe(Math.round(room.width))
  await expect(page.getByTestId('rail')).toBeVisible()
  // the room under it waits: out of reach until the sheet closes
  expect(await page.getByTestId('room').evaluate((e) => (e as HTMLElement).inert)).toBe(true)
  // nothing sideways; a dialog over the room with the keyboard in it
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(thread).toHaveAttribute('role', 'dialog')
  expect(await thread.evaluate((e) => e.contains(document.activeElement))).toBe(true)
  // Esc closes it: the room again, within reach
  await page.keyboard.press('Escape')
  await expect(thread).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
  expect(await page.getByTestId('room').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
  await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
  await expect(thread).toHaveAttribute('data-sheet', '')
  await page.setViewportSize({ width: 1024, height: 860 })
  await expect(thread).not.toHaveAttribute('data-sheet', '')
  expect(await page.getByTestId('room').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
  const beside = (await thread.boundingBox())!
  expect(beside.x).toBeGreaterThan((await page.getByTestId('room').boundingBox())!.x + 400)
})
