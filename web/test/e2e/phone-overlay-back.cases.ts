// Back on a phone closes the open layer first (QA TC-245, lib/backCloses.ts): the iOS edge swipe and Android's Back walk
// the browser's history, so each sheet, menu, dialog, the drawer's search, the side chat's 🕘 list and the new-chat
// picker hold one history entry while open. Back closes only the top one and the page stays; nested ones unwind one per
// Back; closed with ✕ they leave no entry behind; a page opened from inside one takes its entry. A computer's dialog
// adds no entry. Each test runs in WebKit (the iPhone app's engine) and in Chromium (Android's).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const SORA = { id: 'sora', name: '김소라' }
const MESSAGES = [
  { id: '019a5f00-0000-7000-8000-000000000101', author: SORA, body: '시안 올렸어요' },
  { id: '019a5f00-0000-7000-8000-000000000102', author: SORA, body: '내일까지 봐 주세요' },
]
const onOverlay = (page: Page) => page.evaluate(() => typeof (history.state as Record<string, unknown> | null)?.mycelOverlay === 'number')
const historyLength = (page: Page) => page.evaluate(() => history.length)
/** how many overlays' entries are over the page where the history is now (lib/backCloses.ts mycelOverlayDepth) */
const depth = (page: Page) => page.evaluate(() => Number((history.state as Record<string, unknown> | null)?.mycelOverlayDepth ?? 0))
/** Back as the phone does it (the swipe, Android's Back): the history's own back */
const back = (page: Page) => page.goBack({ waitUntil: 'commit' })
/** the entries of a closed overlay are backed off a moment after it closes */
const settled = (page: Page) => expect.poll(() => onOverlay(page)).toBe(false)

async function openRoom(page: Page) {
  await reset(page)
  await routeRoom(page, { members: [SORA], messages: MESSAGES })
  await signIn(page)
  await expect(page).toHaveURL(/\/$/)
  // into the room the way a person goes (the 대화 tab, the row): there is a page under it to go back to
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(MESSAGES.length)
}

/** A long press with a finger on a message: its sheet. */
async function longPress(page: Page, target: Locator) {
  const b = (await target.boundingBox())!
  const at = { button: 0, pointerType: 'touch', isPrimary: true, clientX: b.x + 40, clientY: b.y + b.height / 2 }
  await target.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(650)
  await target.dispatchEvent('pointerup', at)
  await expect(page.getByRole('menu')).toBeVisible()
  await page.waitForTimeout(450)
}

/** The cases, for the engine the spec that calls this runs them in (phone-overlay-back.spec.ts: Chromium, Android's;
 * phone-overlay-back.webkit.spec.ts: WebKit, the iPhone app's). */
export function overlayBackCases() {
  test('a room: the message sheet, ⋯, 🔔, members and the @ list each close with Back, and the room stays', async ({ page }) => {
    await openRoom(page)
    const roomUrl = page.url()
    const start = await historyLength(page)

    // the long-press sheet
    await longPress(page, page.getByTestId('room-message').last())
    expect(await onOverlay(page)).toBe(true)
    await back(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // the header's ⋯
    await page.getByTestId('room-menu').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await back(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // 🔔
    await page.getByTestId('room-notify').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await back(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // ⋯ › 알림 설정: one menu's item opens another (it takes the first one's entry): one Back closes it
    await page.getByTestId('room-menu').click()
    await page.getByTestId('room-menu-notify').click()
    await expect(page.getByRole('menuitemradio')).toHaveCount(4)
    await back(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // members
    await page.getByTestId('room-members-button').click()
    await expect(page.getByTestId('room-info')).toBeVisible()
    await back(page)
    await expect(page.getByTestId('room-info')).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)

    // the @ list: closed, the "@" stays in the box
    await page.getByTestId('room-input').tap()
    await page.keyboard.type('@')
    await expect(page.getByTestId('mention-menu')).toBeVisible()
    await back(page)
    await expect(page.getByTestId('mention-menu')).toHaveCount(0)
    await expect(page.getByTestId('room-input')).toHaveValue('@')
    expect(page.url()).toBe(roomUrl)

    // nothing piled up: the next Back leaves the room
    await settled(page)
    expect(await historyLength(page)).toBeLessThanOrEqual(start + 1)
    await back(page)
    await expect(page).not.toHaveURL(roomUrl)
  })

  test('closed with ✕, the scrim or a choice, an overlay leaves no entry: one Back then leaves the room', async ({ page }) => {
    await openRoom(page)
    const roomUrl = page.url()
    await page.getByTestId('room-members-button').click()
    await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click()
    await expect(page.getByTestId('room-info')).toHaveCount(0)
    await page.getByTestId('room-menu').click()
    await page.getByTestId('room-menu-link').click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await settled(page)
    await back(page)
    await expect(page).not.toHaveURL(roomUrl)
  })

  test('nested: members › a person\'s sheet › the confirm unwind one per Back', async ({ page }) => {
    await openRoom(page)
    const roomUrl = page.url()
    await page.getByTestId('room-members-button').click()
    const info = page.getByTestId('room-info')
    await info.getByTestId('room-member-menu').first().click()
    await page.getByTestId('room-member-remove').click()
    // the sheet gave its entry to the confirm
    const confirm = page.getByRole('dialog').filter({ has: page.getByTestId('dialog-confirm') })
    await expect(confirm).toBeVisible()
    await back(page)
    await expect(confirm).toHaveCount(0)
    await expect(info).toBeVisible()
    await back(page)
    await expect(info).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)
    await settled(page)
    await back(page)
    await expect(page).not.toHaveURL(roomUrl)
  })

  test('a sheet\'s item that opens a second sheet (⋯ › 알림 설정): one entry for the second; Back closes only it, and none is left', async ({ page }) => {
    await openRoom(page)
    const roomUrl = page.url()
    for (const close of ['back', 'choice'] as const) {
      await page.getByTestId('room-menu').click()
      await expect.poll(() => depth(page)).toBe(1)
      await page.getByTestId('room-menu-notify').click()
      const levels = page.getByRole('menuitemradio')
      await expect(levels).toHaveCount(4)
      // the first sheet's entry went to the second: still one over the room
      await expect.poll(() => depth(page)).toBe(1)
      if (close === 'back') await back(page)
      else await page.getByTestId('room-notify-default').click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      expect(page.url()).toBe(roomUrl)
      await expect.poll(() => depth(page)).toBe(0)
    }
    await back(page)
    await expect(page).not.toHaveURL(roomUrl)
  })

  // the drawer's filter and search's type picker are sheets over a sheet once the phone menus (#453) are in
  test('the drawer\'s filter: its row\'s choices (a second sheet) close with one Back, then the drawer; a choice leaves no entry', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByTestId('menu-open').click()
    const drawer = page.locator('[data-drawer]')
    const filter = drawer.getByTestId('recents-filter')
    await filter.click()
    // before #453 it is a computer's dropdown in the drawer, not a sheet
    test.skip((await page.getByTestId('recents-filter-menu').count()) > 0, 'the drawer\'s filter sheet comes with the phone menus (#453)')
    for (const close of ['back', 'choice'] as const) {
      if (close === 'choice') await filter.click()
      await expect.poll(() => depth(page)).toBe(2)
      await page.getByRole('menu').getByRole('menuitem').first().click()
      const choices = page.getByRole('menuitemradio')
      await expect(choices.first()).toBeVisible()
      await expect.poll(() => depth(page)).toBe(2)
      if (close === 'back') await back(page)
      else await choices.first().click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(drawer).toBeVisible()
      await expect.poll(() => depth(page)).toBe(1)
    }
    await back(page)
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
    expect(await depth(page)).toBe(0)
  })

  test('search\'s type picker: one Back closes the picker and search stays; a choice leaves no entry', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByTestId('menu-open').click()
    await page.locator('[data-drawer]').getByTestId('drawer-search').click()
    const search = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
    await expect(search).toBeVisible()
    const type = search.getByTestId('search-type')
    test.skip((await type.count()) === 0, 'search\'s type picker sheet comes with the phone menus (#453)')
    for (const close of ['back', 'choice'] as const) {
      await type.click()
      const choices = page.getByRole('menuitemradio')
      await expect(choices.first()).toBeVisible()
      await expect.poll(() => depth(page)).toBe(2)
      if (close === 'back') await back(page)
      else await choices.first().click()
      await expect(choices).toHaveCount(0)
      await expect(search).toBeVisible()
      await expect.poll(() => depth(page)).toBe(1)
    }
    await back(page)
    await expect(search).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  test('the room\'s ‹ while the @ list is open leaves the room in one tap (the list closes with it)', async ({ page }) => {
    await reset(page)
    await routeRoom(page, { members: [SORA], messages: MESSAGES })
    await signIn(page)
    // into the room from Chats, so ‹ goes back there
    await page.goto('/rooms')
    await page.getByTestId('rooms-row').first().click()
    await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
    await expect(page.getByTestId('room-message')).toHaveCount(MESSAGES.length)
    await page.getByTestId('room-input').tap()
    await page.keyboard.type('@')
    await expect(page.getByTestId('mention-menu')).toBeVisible()
    await page.getByTestId('room-back').click()
    await expect(page).toHaveURL(/\/rooms$/)
    await expect(page.getByTestId('rooms-page')).toBeVisible()
    await expect(page.getByTestId('mention-menu')).toHaveCount(0)
  })

  test('a sheet\'s item that opens a screen already in the stack (Scheduled + › 채팅으로 설명하기): Trina, and the app stays', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await expect(page).toHaveURL(/\/$/)
    await page.getByTestId('menu-open').click()
    await page.locator('[data-drawer]').getByTestId('nav-scheduled').click()
    await expect(page).toHaveURL(/\/scheduled$/)
    await page.getByTestId('new-task-phone').click()
    await page.getByTestId('new-task-chat').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    // nothing goes one entry too far a moment later (two backs at once)
    await page.waitForTimeout(1200)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    expect(await onOverlay(page)).toBe(false)
  })

  test('the side chat\'s 🕘 list: Back closes the list, then the side chat, then the room is left', async ({ page }) => {
    await openRoom(page)
    const roomUrl = page.url()
    await page.getByTestId('room-side-chat-button').click()
    const side = page.getByTestId('room-side-chat')
    await expect(side).toBeVisible()
    await side.getByTestId('side-chat-history').click()
    await expect(side.getByTestId('side-chat-history-list')).toBeVisible()
    await back(page)
    await expect(side.getByTestId('side-chat-history-list')).toHaveCount(0)
    await expect(side).toBeVisible()
    await back(page)
    await expect(side).toHaveCount(0)
    expect(page.url()).toBe(roomUrl)
    await back(page)
    await expect(page).not.toHaveURL(roomUrl)
  })

  test('search from the drawer (TRINA-20): Back closes search and stays on Trina; the next Back goes where you were with nothing open', async ({ page }) => {
    await reset(page)
    await signIn(page)
    // where you were before Trina: Chats, opened as its own page (so the step back does not depend on how tab taps keep
    // the history)
    await page.goto('/rooms')
    await expect(page.getByTestId('rooms-page')).toBeVisible()
    await page.goto('/')
    await page.getByTestId('menu-open').click()
    await page.locator('[data-drawer]').getByTestId('drawer-search').click()
    const search = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
    await expect(search).toBeVisible()
    // the drawer gave search its place
    await expect(page.locator('[data-drawer]')).toHaveCount(0)
    await back(page)
    await expect(search).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-drawer]')).toHaveCount(0)
    await back(page)
    await expect(page).toHaveURL(/\/rooms$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('a page opened from inside the drawer takes its entry: Back from it is Trina with the drawer closed', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const start = await historyLength(page)
    await page.getByTestId('menu-open').click()
    await page.locator('[data-drawer]').getByTestId('nav-skills').click()
    await expect(page).toHaveURL(/\/skills$/)
    // one step at most: the drawer's entry is the new page's, none is left under it
    expect(await historyLength(page)).toBeLessThanOrEqual(start + 1)
    await back(page)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-drawer]')).toHaveCount(0)
    expect(await onOverlay(page)).toBe(false)
  })

  test('the new-chat picker (CHATS-05): Back closes it and stays on Chats; the next Back leaves Chats', async ({ page }) => {
    await reset(page)
    await signIn(page)
    // Chats opened as its own page after Trina (not a tab tap: the step back does not depend on how tabs keep history)
    await page.goto('/rooms')
    await expect(page.getByTestId('rooms-page')).toBeVisible()
    await page.getByTestId('topbar-new-dm').click()
    const picker = page.getByRole('dialog', { name: '새 대화' })
    await expect(picker).toBeVisible()
    await back(page)
    await expect(picker).toHaveCount(0)
    await expect(page).toHaveURL(/\/rooms$/)
    // ✕ then: no entry left either
    await page.getByTestId('topbar-new-dm').click()
    await picker.getByRole('button', { name: '닫기' }).click()
    await expect(picker).toHaveCount(0)
    await settled(page)
    await back(page)
    await expect(page).not.toHaveURL(/\/rooms/)
  })

  test('a chat\'s title ⌄ menu closes with Back and the chat stays', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const chat = (await (await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: {} })).json()) as { id: string }
    await page.goto(`/c/${chat.id}`)
    await page.getByTestId('chat-menu').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await back(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/c/${chat.id}$`))
  })

  test('Files (FILES-12): Move and Version history close with Back and the folder stays', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    const row = page.getByTestId('file-row').filter({ hasText: 'notes.txt' })
    await expect(row).toBeVisible()
    const url = page.url()
    for (const item of ['옮기기', '버전 기록']) {
      await row.getByTestId('file-menu').click()
      await page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await back(page)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(page.url()).toBe(url)
    }
  })

  test('Admin (ADM-04): the invite sheet and Activity log\'s Filters close with Back; a filter chosen meanwhile is kept', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/admin/members')
    await page.getByTestId('invite-new').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await back(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).toHaveURL(/\/admin\/members$/)

    await page.goto('/admin/audit')
    await page.getByTestId('activity-more-toggle').click()
    const kinds = page.getByTestId('activity-kinds')
    await expect(kinds).toBeVisible()
    await kinds.getByRole('button').nth(1).click()
    await expect(page).toHaveURL(/[?&]kind=/)
    const filtered = page.url()
    await back(page)
    await expect(kinds).toBeHidden()
    expect(page.url()).toBe(filtered)
    // and Back again leaves the page in one press (to Admin's list, put under a page opened from outside it): no entry
    // with the old address was left under it
    await back(page)
    await expect(page).toHaveURL(/\/admin$/)
  })

  test.describe('a computer', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
    test('a dialog or a menu adds no history entry there', async ({ page }) => {
      await openRoom(page)
      const start = await historyLength(page)
      await page.getByTestId('room-members-button').click()
      await expect(page.getByTestId('room-info')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByTestId('room-menu').click()
      await expect(page.getByRole('menu')).toBeVisible()
      expect(await historyLength(page)).toBe(start)
      expect(await onOverlay(page)).toBe(false)
    })
  })
}
