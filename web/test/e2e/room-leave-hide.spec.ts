// A conversation's "⋯" and hidden conversations in the browser (docs/DECISIONS.md "대화 숨기기";
// components/rooms/RoomMenu.tsx): the menu in a room's header by kind (a group chat's 대화방 나가기, a DM's 대화 숨기기,
// a team room's 숨기기, 알림 설정 opening the bell's levels, 링크 복사), on a sidebar row (hover, keyboard, right-click),
// on a phone a long press on a row of the 대화 list; hidden rooms out of the sidebar and the counts, under "숨긴 대화 N"
// on the conversations page with 다시 보이기, and shown again when opened. The rooms are answered through page.route
// (rooms-mock.ts routeRooms). With SHOTS_DIR set, the last test saves the screens for review (1440 and 390, light and
// dark).
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const rid = (n: number) => `019a5f00-0000-7000-8000-0000000b${String(n).padStart(4, '0')}`
const SORA = { id: 'sora', name: '김소라' }
const MINSU = { id: 'minsu', name: '이민수' }
const JIWOO = { id: 'jiwoo', name: '박지우' }
const GROUP = rid(1), DM = rid(2), TEAM = rid(3), ALL = rid(4), HIDDEN_DM = rid(5)
const ROOMS: MockRoomSpec[] = [
  { id: GROUP, kind: 'group', name: '디자인 리뷰', peers: [SORA, MINSU], unread: 2, ago: 3, last: '시안 2차 올렸어요' },
  { id: DM, kind: 'dm', name: null, peers: [SORA], unread: 1, ago: 8, last: '내일 회의 10시 맞죠?' },
  { id: TEAM, kind: 'team', name: '개발팀', peers: [MINSU, JIWOO], ago: 20, last: '배포 끝났어요' },
  { id: ALL, kind: 'all', name: null, peers: [SORA, MINSU, JIWOO], ago: 45, last: '점심 같이 하실 분' },
  // hidden, with the newest message and two unread: in none of the rows or counts
  { id: HIDDEN_DM, kind: 'dm', name: null, peers: [JIWOO], unread: 2, ago: 1, last: '지난번 자료 감사해요', hidden: true },
]

async function start(page: Page, rooms = ROOMS) {
  await reset(page)
  const state = await routeRooms(page, rooms)
  await signIn(page)
  return state
}
const sidebarRow = (page: Page, name: string) => page.getByTestId('sidebar-room-row').filter({ hasText: name })

test('sidebar: a hidden room is in no row or count; a row\'s "⋯" on hover, focus and right-click; hiding a DM', async ({ page }) => {
  const state = await start(page)
  await expect(page.getByTestId('sidebar-room')).toHaveCount(4)
  await expect(page.getByTestId('sidebar-rooms-list')).not.toContainText('박지우')
  // nothing behind "더 보기": the way to every room, the hidden one too
  await expect(page.getByTestId('rooms-all')).toBeVisible()

  // hover: the "⋯" takes the pill's place, with its tooltip
  const row = sidebarRow(page, '김소라')
  const menu = row.getByTestId('sidebar-room-menu')
  expect(await menu.evaluate((e) => getComputedStyle(e).opacity)).toBe('0')
  await row.hover()
  await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  expect(await row.getByTestId('room-unread').evaluate((e) => getComputedStyle(e).opacity)).toBe('0')
  await menu.hover()
  await expect(page.getByRole('tooltip')).toHaveText('더 보기')
  await expect(menu).toHaveAccessibleName('김소라 더 보기')

  // right-click anywhere on the row: the same menu, a DM's items
  await page.mouse.move(0, 0)
  await row.getByTestId('sidebar-room').click({ button: 'right' })
  const items = page.getByRole('menu').getByRole('menuitem')
  await expect(items).toHaveText(['알림 설정', '링크 복사', '대화 숨기기'])
  await page.getByTestId('room-menu-hide').click()
  await expect.poll(() => state.hidden).toEqual([{ roomId: DM, hidden: true }])
  await expect(page.getByTestId('sidebar-room')).toHaveCount(3)
  // where it went and how it comes back, with an undo
  await expect(page.getByText('대화를 숨겼어요. 새 메시지가 오면 다시 보여요.')).toBeVisible()
  await page.getByRole('button', { name: '실행 취소' }).click()
  await expect.poll(() => state.hidden).toEqual([{ roomId: DM, hidden: true }, { roomId: DM, hidden: false }])
  await expect(page.getByTestId('sidebar-room')).toHaveCount(4)

  // the keyboard: Tab onto a row shows its "⋯", Enter opens it, Esc gives the focus back
  const team = sidebarRow(page, '개발팀')
  await team.getByTestId('sidebar-room').focus()
  await page.keyboard.press('Tab')
  await expect(team.getByTestId('sidebar-room-menu')).toBeFocused()
  await expect.poll(() => team.getByTestId('sidebar-room-menu').evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('room-menu-hide')).toHaveText('숨기기')
  await page.keyboard.press('Escape')
  await expect(team.getByTestId('sidebar-room-menu')).toBeFocused()
})

test('the room header\'s "⋯" by kind; 알림 설정 opens the bell\'s levels; 링크 복사', async ({ page }) => {
  const state = await start(page)
  const items = page.getByRole('menu').getByRole('menuitem')
  // a group chat: leave (with the confirm)
  await page.goto(`/rooms/${GROUP}`)
  await expect(page.getByTestId('room-title')).toHaveText('디자인 리뷰')
  await page.getByTestId('room-menu').click()
  await expect(items).toHaveText(['알림 설정', '링크 복사', '대화방 나가기'])
  // 알림 설정: the bell's own four levels, the keyboard in them
  await page.getByTestId('room-menu-notify').click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(4)
  await expect(page.getByTestId('room-notify-default')).toBeFocused()
  await page.getByTestId('room-notify-off').click()
  await expect.poll(() => state.updated).toEqual([{ roomId: GROUP, body: { notifyLevel: 'off' } }])
  // 링크 복사: the room's address
  await page.getByTestId('room-menu').click()
  await page.getByTestId('room-menu-link').click()
  await expect(page.getByText('링크를 복사했어요.')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/rooms/${GROUP}`)
  // leaving asks first; then the room is gone
  await page.getByTestId('room-menu').click()
  await page.getByTestId('room-menu-leave').click()
  await page.getByRole('dialog').getByRole('button', { name: '대화방 나가기' }).click()
  await expect.poll(() => state.left).toEqual([GROUP])
  await expect(page).toHaveURL(/\/rooms$/)

  // a DM: hide; hiding the room on screen goes to the list
  await page.goto(`/rooms/${DM}`)
  await page.getByTestId('room-menu').click()
  await expect(items).toHaveText(['알림 설정', '링크 복사', '대화 숨기기'])
  await page.getByTestId('room-menu-hide').click()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect.poll(() => state.hidden).toEqual([{ roomId: DM, hidden: true }])
  // a team room and the everyone room: hide (they follow the groups: no leave)
  for (const id of [TEAM, ALL]) {
    await page.goto(`/rooms/${id}`)
    await page.getByTestId('room-menu').click()
    await expect(items).toHaveText(['알림 설정', '링크 복사', '숨기기'])
    await page.keyboard.press('Escape')
  }
})

test('the conversations page: "숨긴 대화 N" at the end, 다시 보이기; opening a hidden room shows it again', async ({ page }) => {
  const state = await start(page)
  await page.goto('/rooms')
  await expect(page.getByTestId('rooms-row')).toHaveCount(4)
  const toggle = page.getByTestId('rooms-hidden-toggle')
  await expect(toggle).toHaveText('숨긴 대화 1')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(page.getByTestId('rooms-hidden-row')).toHaveText(/박지우/)
  await page.getByTestId('rooms-hidden-show').click()
  await expect.poll(() => state.hidden).toEqual([{ roomId: HIDDEN_DM, hidden: false }])
  await expect(page.getByTestId('rooms-row')).toHaveCount(5)
  await expect(page.getByTestId('rooms-hidden')).toHaveCount(0)
  // it is newest: first in the sidebar too
  await expect(page.getByTestId('sidebar-room').first()).toContainText('박지우')

  // hide the team room from its row's "⋯", then open it by its address: it is shown again
  await page.getByTestId('rooms-row').filter({ hasText: '개발팀' }).click({ button: 'right' })
  await page.getByTestId('room-menu-hide').click()
  await expect(page.getByTestId('rooms-hidden-toggle')).toHaveText('숨긴 대화 1')
  await page.goto(`/rooms/${TEAM}`)
  await expect(page.getByTestId('room-title')).toHaveText('개발팀')
  await expect.poll(() => state.hidden.at(-1)).toEqual({ roomId: TEAM, hidden: false })
})

test('WCAG 2.2 AA (axe), light and dark: the conversations page with its hidden section and a row\'s menu, a room\'s header menu', async ({ page }) => {
  await start(page)
  const check = async (where: string) => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.goto('/rooms')
    const toggle = page.getByTestId('rooms-hidden-toggle')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await expect(page.getByTestId('rooms-hidden-row')).toHaveCount(1)
    await check(`${scheme} /rooms`)
    await page.getByTestId('rooms-row').first().click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await check(`${scheme} /rooms row menu`)
    await page.keyboard.press('Escape')
    await page.goto(`/rooms/${GROUP}`)
    await page.getByTestId('room-menu').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await check(`${scheme} room header menu`)
  }
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a long press on a row of the 대화 list opens its menu as a sheet; the 대화 tab leaves a hidden room out', async ({ page }) => {
    const state = await start(page)
    await page.goto('/rooms')
    // 2 + 1 unread in the rooms shown; the hidden DM's 2 are not counted
    await expect(page.getByTestId('tab-chats-unread')).toContainText('3')
    const row = page.getByTestId('rooms-row').filter({ hasText: '개발팀' })
    // no "⋯" on a touch screen: the long press is the way
    await expect(page.getByTestId('rooms-row-menu').first()).toBeHidden()
    await row.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    await page.waitForTimeout(650)
    await row.dispatchEvent('pointerup', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    const sheet = page.getByRole('menu')
    await expect(sheet.getByRole('menuitem')).toHaveText(['알림 설정', '링크 복사', '숨기기'])
    // the room it is about, on top of the sheet (the row is under the scrim)
    await expect(sheet.getByTestId('menu-sheet-title')).toHaveText('개발팀')
    // a sheet from the bottom, 48px rows, the room still on screen under it (no room opened by the finger lifting)
    const box = (await sheet.boundingBox())!
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(840)
    expect((await sheet.getByRole('menuitem').first().boundingBox())!.height).toBeGreaterThanOrEqual(48)
    await expect(page).toHaveURL(/\/rooms$/)
    await page.waitForTimeout(450)
    await page.getByTestId('room-menu-hide').click()
    await expect.poll(() => state.hidden).toEqual([{ roomId: TEAM, hidden: true }])
    await expect(page.getByTestId('rooms-row')).toHaveCount(3)

    // in a room, the top bar has the "⋯" beside the bell
    await page.goto(`/rooms/${DM}`)
    await expect(page.getByTestId('room-menu')).toBeVisible()
    await page.getByTestId('room-menu').click()
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['알림 설정', '링크 복사', '대화 숨기기'])
  })
})

// ---------------- screenshots for review (SHOTS_DIR) ----------------
const shots = (page: Page) => {
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  return (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test('screenshots at 1440: header menus by kind, a sidebar row and its menu, the hidden section (light and dark)', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test.setTimeout(180_000)
  const shot = shots(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    for (const [id, name] of [[GROUP, 'group'], [DM, 'dm'], [TEAM, 'team']] as const) {
      await page.goto(`/rooms/${id}`)
      await expect(page.getByTestId('room-message')).toHaveCount(1)
      await page.getByTestId('room-menu').click()
      await expect(page.getByRole('menu')).toBeVisible()
      await shot(`1440-${scheme}-header-${name}`)
      await page.keyboard.press('Escape')
    }
    await page.goto(`/rooms/${TEAM}`)
    await sidebarRow(page, '김소라').hover()
    await shot(`1440-${scheme}-sidebar-hover`)
    await sidebarRow(page, '김소라').getByTestId('sidebar-room').click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await shot(`1440-${scheme}-sidebar-menu`)
    await page.keyboard.press('Escape')
    await page.goto('/rooms')
    const toggle = page.getByTestId('rooms-hidden-toggle')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await page.getByTestId('rooms-row').first().hover()
    await shot(`1440-${scheme}-rooms-hidden`)
  }
})

test.describe('phone screenshots', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('screenshots at 390: the 대화 list with its hidden section, a long-press sheet, a room\'s top bar and its menu (light and dark)', async ({ page }) => {
    test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
    test.setTimeout(180_000)
    const shot = shots(page)
    await start(page)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.goto('/rooms')
      const toggle = page.getByTestId('rooms-hidden-toggle')
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
      await expect(page.getByTestId('rooms-hidden-row')).toHaveCount(1)
      await shot(`390-${scheme}-rooms-hidden`)
      const row = page.getByTestId('rooms-row').filter({ hasText: '개발팀' })
      await row.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
      await page.waitForTimeout(650)
      await row.dispatchEvent('pointerup', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
      await expect(page.getByRole('menu')).toBeVisible()
      await shot(`390-${scheme}-longpress-sheet`)
      await page.waitForTimeout(450)
      await page.keyboard.press('Escape')
      for (const [id, name] of [[DM, 'dm'], [GROUP, 'group']] as const) {
        await page.goto(`/rooms/${id}`)
        await expect(page.getByTestId('room-message')).toHaveCount(1)
        await shot(`390-${scheme}-room-${name}`)
        await page.getByTestId('room-menu').click()
        await expect(page.getByRole('menu')).toBeVisible()
        await shot(`390-${scheme}-header-${name}`)
        await page.keyboard.press('Escape')
      }
    }
  })
})
