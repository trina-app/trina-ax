// Pinned conversations in the browser (docs/DECISIONS.md "Pinned conversations"; components/rooms/RoomMenu.tsx,
// SidebarRooms.tsx, pages/Rooms.tsx): 상단에 고정 from a sidebar row's "⋯" and from a right-click moves the room to the
// top with the pin after its name, the most recently pinned first, and it stays after a reload; 고정 해제 puts it back
// in its place by activity; hiding a pinned room unpins it and the undo pins it again. The conversations page: the
// AI's row first, then the pins, then the others; on a phone the 대화 tab has the pins first and a long press pins.
// The rooms are answered through page.route (rooms-mock.ts routeRooms). With SHOTS_DIR set, the last tests save the
// sidebar with two pins at 1440 and the 대화 tab at 390 (light).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const rid = (n: number) => `019a5f00-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`
const SORA = { id: 'sora', name: '김소라' }
const MINSU = { id: 'minsu', name: '이민수' }
const JIWOO = { id: 'jiwoo', name: '박지우' }
const GROUP = rid(1), DM = rid(2), TEAM = rid(3), ALL = rid(4), DM2 = rid(5), GROUP2 = rid(6), TEAM2 = rid(7)
const ROOMS: MockRoomSpec[] = [
  { id: GROUP, kind: 'group', name: '디자인 리뷰', peers: [SORA, MINSU], unread: 2, ago: 3, last: '시안 2차 올렸어요' },
  { id: DM, kind: 'dm', name: null, peers: [SORA], unread: 1, ago: 8, last: '내일 회의 10시 맞죠?' },
  { id: TEAM, kind: 'team', name: '개발팀', peers: [MINSU, JIWOO], ago: 20, last: '배포 끝났어요' },
  { id: ALL, kind: 'all', name: null, peers: [SORA, MINSU, JIWOO], ago: 45, last: '점심 같이 하실 분' },
  { id: DM2, kind: 'dm', name: null, peers: [JIWOO], ago: 90, last: '지난번 자료 감사해요' },
  { id: GROUP2, kind: 'group', name: '마케팅 주간회의', peers: [SORA, JIWOO], ago: 300, last: '안건 정리했어요' },
  { id: TEAM2, kind: 'team', name: '영업팀', peers: [MINSU], ago: 600, last: '견적서 보냈어요' },
]
/** the same rooms with 영업팀 and 전체 pinned (전체 the later) */
const PINNED = ROOMS.map((r) => (r.id === TEAM2 ? { ...r, pinnedAt: '2026-11-06T09:00:00.000Z' } : r.id === ALL ? { ...r, pinnedAt: '2026-11-06T10:00:00.000Z' } : r))

async function start(page: Page, rooms = ROOMS) {
  await reset(page)
  const state = await routeRooms(page, rooms)
  await signIn(page)
  return state
}
/** the sidebar's room names, in order (the name's own span: no picture initials or unread pill) */
const sidebarOrder = (page: Page) => page.getByTestId('sidebar-room').locator('span[title]').allTextContents()
const sidebarRow = (page: Page, name: string) => page.getByTestId('sidebar-room-row').filter({ hasText: name })

test('sidebar: 상단에 고정 from a row\'s "⋯" and from a right-click moves it to the top with the pin; 고정 해제 puts it back', async ({ page }) => {
  const state = await start(page)
  await expect.poll(() => sidebarOrder(page)).toEqual(['디자인 리뷰', '김소라', '개발팀', '전체', '박지우'])
  await expect(page.getByTestId('room-pin-icon')).toHaveCount(0)

  // the row's "⋯": 상단에 고정 is its first item
  const team = sidebarRow(page, '개발팀')
  await team.hover()
  await team.getByTestId('sidebar-room-menu').click()
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toHaveText('상단에 고정')
  await page.getByTestId('room-menu-pin').click()
  await expect.poll(() => state.pinned).toEqual([{ roomId: TEAM, pinned: true }])
  // first, with the pin after its name (named for screen readers); the five latest others below it
  await expect.poll(() => sidebarOrder(page)).toEqual(['개발팀', '디자인 리뷰', '김소라', '전체', '박지우', '마케팅 주간회의'])
  await expect(sidebarRow(page, '개발팀').getByTestId('room-pin-icon')).toHaveAttribute('aria-label', '고정됨')
  await expect(page.getByTestId('room-pin-icon')).toHaveCount(1)

  // a right-click on another row: the most recently pinned comes first
  await page.mouse.move(0, 0)
  await sidebarRow(page, '박지우').getByTestId('sidebar-room').click({ button: 'right' })
  await page.getByTestId('room-menu-pin').click()
  await expect.poll(() => state.pinned.length).toBe(2)
  await expect.poll(() => sidebarOrder(page)).toEqual(['박지우', '개발팀', '디자인 리뷰', '김소라', '전체', '마케팅 주간회의', '영업팀'])
  await expect(page.getByTestId('room-pin-icon')).toHaveCount(2)

  // after a reload too (the server keeps it)
  await page.reload()
  await expect.poll(async () => (await sidebarOrder(page))[0]).toBe('박지우')
  await expect(page.getByTestId('room-pin-icon')).toHaveCount(2)

  // 고정 해제: back in its place by activity, without the pin
  await sidebarRow(page, '개발팀').getByTestId('sidebar-room').click({ button: 'right' })
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toHaveText('고정 해제')
  await page.getByTestId('room-menu-unpin').click()
  await expect.poll(() => state.pinned.at(-1)).toEqual({ roomId: TEAM, pinned: false })
  await expect.poll(() => sidebarOrder(page)).toEqual(['박지우', '디자인 리뷰', '김소라', '개발팀', '전체', '마케팅 주간회의'])
  await expect(sidebarRow(page, '개발팀').getByTestId('room-pin-icon')).toHaveCount(0)

  // hiding a pinned DM unpins it; the undo shows it and pins it again
  await sidebarRow(page, '박지우').getByTestId('sidebar-room').click({ button: 'right' })
  await page.getByTestId('room-menu-hide').click()
  await expect.poll(() => state.hidden).toEqual([{ roomId: DM2, hidden: true }])
  await expect(sidebarRow(page, '박지우')).toHaveCount(0)
  await page.getByRole('button', { name: '실행 취소' }).click()
  await expect.poll(() => state.pinned.at(-1)).toEqual({ roomId: DM2, pinned: true })
  await expect.poll(async () => (await sidebarOrder(page))[0]).toBe('박지우')
  await expect(sidebarRow(page, '박지우').getByTestId('room-pin-icon')).toHaveCount(1)
})

test('the conversations page: the 트리나 row first, then the pins (the most recently pinned first), then the others', async ({ page }) => {
  const state = await start(page, PINNED)
  await page.goto('/rooms')
  const rows = page.getByTestId('rooms-row')
  await expect(rows).toHaveCount(7)
  // the AI's row is the list's very first row
  const first = page.locator('[data-testid="rooms-page"] ul > li').first()
  await expect(first.getByTestId('rooms-ai')).toBeVisible()
  const names = ['전체', '영업팀', '디자인 리뷰', '김소라', '개발팀', '박지우', '마케팅 주간회의']
  for (const [i, n] of names.entries()) await expect(rows.nth(i)).toContainText(n)
  await expect(rows.nth(0).getByTestId('room-pin-icon')).toBeVisible()
  await expect(rows.nth(1).getByTestId('room-pin-icon')).toBeVisible()
  await expect(page.getByTestId('room-pin-icon')).toHaveCount(4)

  // pinned from its row's right-click: right under the AI's row
  await rows.filter({ hasText: '마케팅 주간회의' }).click({ button: 'right' })
  await page.getByTestId('room-menu-pin').click()
  await expect.poll(() => state.pinned).toEqual([{ roomId: GROUP2, pinned: true }])
  await expect(rows.nth(0)).toContainText('마케팅 주간회의')
  await expect(first.getByTestId('rooms-ai')).toBeVisible()
  // the sidebar has the same order
  await expect.poll(async () => (await sidebarOrder(page)).slice(0, 3)).toEqual(['마케팅 주간회의', '전체', '영업팀'])
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the 대화 tab: pins first; a long press pins a room, which moves to the top', async ({ page }) => {
    const state = await start(page, PINNED)
    await page.goto('/rooms')
    const rows = page.getByTestId('rooms-row')
    await expect(rows.nth(0)).toContainText('전체')
    await expect(rows.nth(1)).toContainText('영업팀')
    const row = rows.filter({ hasText: '개발팀' })
    await row.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    await page.waitForTimeout(650)
    await row.dispatchEvent('pointerup', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    const sheet = page.getByRole('menu')
    await expect(sheet.getByRole('menuitem')).toHaveText(['상단에 고정', '알림 설정', '링크 복사', '숨기기'])
    await page.waitForTimeout(450)
    await page.getByTestId('room-menu-pin').click()
    await expect.poll(() => state.pinned).toEqual([{ roomId: TEAM, pinned: true }])
    await expect(rows.nth(0)).toContainText('개발팀')
    await expect(rows.nth(0).getByTestId('room-pin-icon')).toBeVisible()
    await expect(page).toHaveURL(/\/rooms$/)
  })
})

// ---------------- screenshots for review (SHOTS_DIR) ----------------
const shots = (page: Page) => {
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  return (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test('screenshot at 1440 (light): the sidebar with two pinned rooms', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  const shot = shots(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await start(page, PINNED)
  await page.goto(`/rooms/${GROUP}`)
  await expect(page.getByTestId('room-message')).toHaveCount(1)
  await expect(page.getByTestId('room-pin-icon')).toHaveCount(2)
  await shot('1440-light-sidebar-pins')
  await sidebarRow(page, '전체').getByTestId('sidebar-room').click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await shot('1440-light-sidebar-pin-menu')
})

test.describe('phone screenshot', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('screenshot at 390 (light): the 대화 tab with two pinned rooms', async ({ page }) => {
    test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
    const shot = shots(page)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await start(page, PINNED)
    await page.goto('/rooms')
    await expect(page.getByTestId('room-pin-icon')).toHaveCount(2)
    await shot('390-light-rooms-pins')
  })
})
