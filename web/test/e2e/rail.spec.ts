// The new navigation on computers (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P1), with the server's
// `navRail` switch on: the rail (team logo, 트리나 · 대화 · 파일 · 활동, my photo) in place of the 280 px sidebar, one list
// panel for 트리나 and 대화 (268 px at 1440, 240 px at 1280 and 1024), what each place remembers, the marks on the
// places, the panel folding beside a thread below 1052 px, its hide button, Admin with one menu, the logo and photo
// menus per role, the keyboard, and ⌘K's new words. With the switch off nothing here shows (nav-rail-flag.spec.ts).
// With SHOTS=1 it also takes the screenshots of the phase into $SHOTS_DIR (default test-results/rail): each place at 1440
// light and dark, 1280 light and 1024 with a room's thread open, as the owner and as a member.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, openRail, reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const MEMBER = { username: 'bob', password: 'bob password 1' }
const MINJUN = { id: 'minjun', name: '민준' }, SEOYEON = { id: 'seoyeon', name: '서연' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ROOT = id(300)

async function start(page: Page, width: number, who?: typeof MEMBER) {
  await page.setViewportSize({ width, height: 860 })
  await reset(page)
  await navRail(page)
  await signIn(page, who)
  await expect(page.getByTestId('rail')).toBeVisible()
}

/** a room with a thread (rooms-mock.ts), and the room list around it: the room has three unread, another one more */
async function roomWithThread(page: Page) {
  await routeRoom(page, {
    kind: 'team', members: [MINJUN, SEOYEON],
    messages: [{ id: ROOT, author: MINJUN, body: '다음 주 발표 시안, 어떻게 나눌까요?' }, { id: id(301), author: SEOYEON, body: '제가 표지를 맡을게요', threadRootId: ROOT }, { id: id(302), author: MINJUN, body: '좋아요, 금요일까지 부탁해요', threadRootId: ROOT }],
    room: { unreadCount: 3 },
  })
}

/** GET /api/notifications answered with these counts: `rooms` of the `unread` are conversation rows */
const routeNotices = (page: Page, unread: number, rooms: number) =>
  page.route('**/api/notifications?*', (route) => route.fulfill({ json: { items: [], nextCursor: null, unreadCount: unread, roomUnreadCount: rooms } }))

const width = async (page: Page, testId: string) => Math.round((await page.getByTestId(testId).boundingBox())!.width)

test('the rail replaces the sidebar; four places in order; 트리나 and 대화 have a list panel, 파일 and 활동 open their page at full width', async ({ page }) => {
  await start(page, 1440)
  await expect(page.getByRole('navigation', { name: t['sidebar.label'] })).toHaveCount(0)
  const rail = page.getByRole('navigation', { name: t['rail.label'] })
  expect(await rail.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['rail-ai', 'rail-chats', 'rail-files', 'rail-activity'])
  await expect(page.getByTestId('rail-chats')).toContainText(t['tabs.chats'])
  await expect(page.getByTestId('rail-files')).toContainText(t['sidebar.files'])
  await expect(page.getByTestId('rail-activity')).toContainText(t['inbox.title'])
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('trina-panel')).toBeVisible()
  // the old sidebar's seven rows: ask and search on top of 트리나's list, the rest at its end; Files and Activity are places
  await expect(page.getByTestId('trina-panel').getByTestId('new-chat')).toContainText('트리나에게 묻기')
  await expect(page.getByTestId('trina-panel').getByTestId('nav-search')).toBeVisible()
  for (const row of ['nav-projects', 'nav-scheduled', 'nav-skills', 'nav-trash']) await expect(page.getByTestId('trina-panel').getByTestId(row)).toBeVisible()
  await expect(page.getByTestId('nav-files')).toHaveCount(0)
  await expect(page.getByTestId('nav-inbox')).toHaveCount(0)
  expect(await width(page, 'rail')).toBe(72)
  expect(await width(page, 'trina-panel')).toBe(268)

  await openRail(page, 'chats')
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  await expect(page.getByTestId('chats-panel').getByTestId('rooms-activity')).toContainText(t['feed.chats'])
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  // the panel is the list: the page beside it does not repeat it (no rooms, no AI row, no second 새 대화)
  await expect(page.getByTestId('rooms-pick')).toHaveText(t['rail.pickConversation'])
  for (const x of ['rooms-ai', 'rooms-page-new-dm', 'rooms-row']) await expect(page.getByTestId('rooms-page').getByTestId(x)).toHaveCount(0)

  await openRail(page, 'files')
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)

  await openRail(page, 'activity')
  await expect(page.getByTestId('activity')).toBeVisible()
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
})

test('each place opens what was open in it; the lit place again goes to its start', async ({ page }) => {
  await start(page, 1440)
  await page.getByTestId('trina-panel').getByTestId('nav-scheduled').click()
  await expect(page).toHaveURL(/\/scheduled$/)
  await openRail(page, 'chats')
  await page.goto('/activity?in=chats')
  // 멘션·스레드 belongs to 대화
  await expect(page.getByTestId('rail-chats')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('rooms-activity')).toHaveAttribute('aria-current', 'page')
  await openRail(page, 'ai')
  await expect(page).toHaveURL(/\/scheduled$/)
  await openRail(page, 'chats')
  await expect(page).toHaveURL(/\/activity\?in=chats$/)
  // pressed again: its start
  await page.getByTestId('rail-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  await openRail(page, 'ai')
  await page.getByTestId('rail-ai').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  // Settings is a dialog over the page: the place under it stays lit
  await page.goto('/scheduled')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-settings').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
})

test('marks: 대화 counts conversations, 활동 the notices that are not conversations, 멘션·스레드 its own; "?" on 대화 while a room\'s AI waits', async ({ page }) => {
  await routeNotices(page, 5, 2)
  await start(page, 1280)
  const now = new Date().toISOString()
  const base = { canRename: false, managerId: null, memberCount: 2, lastReadSeq: 0, lastSeq: 9, lastMessage: null, muted: false, createdAt: now, activityAt: now, mentioned: false, unreadCount: 0, threadsUnread: 0, nextThreadId: null, peers: [MINJUN] }
  const rooms = [
    { ...base, id: id(1), kind: 'dm', name: null, groupId: null, unreadCount: 3 },
    { ...base, id: id(2), kind: 'team', name: '마케팅팀', groupId: id(20), unreadCount: 12 },
    { ...base, id: id(3), kind: 'team', name: '영업팀', groupId: id(21), threadsUnread: 2, mentioned: true },
    { ...base, id: id(4), kind: 'team', name: '조용한 방', groupId: id(22), unreadCount: 7, muted: true },
  ]
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
  await expect(page.getByTestId('rail-chats-mark')).toHaveAttribute('data-n', '3')
  await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '3')
  await expect(page.getByTestId('rail-files-mark')).toHaveCount(0)
  await openRail(page, 'chats')
  await expect(page.getByTestId('chats-panel').getByTestId('rooms-activity-unread')).toContainText('2')
  // a room's AI waits on me: "?" on 대화
  expect((await page.request.post('/__test/rooms', { data: { rooms: [{ ...rooms[0], aiWaits: true }, ...rooms.slice(1)] } })).ok()).toBeTruthy()
  await expect(page.getByTestId('rail-chats-mark')).toHaveAttribute('data-mark', 'ask')
  await expect(page.getByTestId('rail-chats-mark')).toContainText(t['rooms.aiWaits'])
})

for (const w of [1024, 1100] as const)
  test(`${w} px with a thread open: the list ${w < 1052 ? 'folds away and comes back when it closes' : 'stays'}; the rail stays`, async ({ page }) => {
    await roomWithThread(page)
    await start(page, w)
    await page.goto(`/rooms/${ROOM_ID}`)
    await expect(page.getByTestId('chats-panel')).toBeVisible()
    expect(await width(page, 'chats-panel')).toBe(240)
    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
    await expect(page.getByTestId('room-thread')).toBeVisible()
    await expect(page.getByTestId('rail')).toBeVisible()
    if (w < 1052) {
      await expect(page.getByTestId('chats-panel')).toHaveCount(0)
      // the room and its thread keep their minimums (420 + 320)
      expect(await width(page, 'room')).toBeGreaterThanOrEqual(420)
      await page.goto(`/rooms/${ROOM_ID}`)
      await expect(page.getByTestId('chats-panel')).toBeVisible()
      // the room's ✦ side chat folds it too
      await page.getByTestId('room-side-chat-button').click()
      await expect(page.getByTestId('room-side-chat')).toBeVisible()
      await expect(page.getByTestId('chats-panel')).toHaveCount(0)
      await page.getByTestId('room-side-chat-button').click()
      await expect(page.getByTestId('chats-panel')).toBeVisible()
    } else {
      await expect(page.getByTestId('chats-panel')).toBeVisible()
      await expect(page.getByTestId('panel-hide')).toHaveCount(0)
    }
  })

test('below 1052 px the list can be hidden and shown again; remembered in this browser', async ({ page }) => {
  await start(page, 1024)
  await expect(page.getByTestId('trina-panel')).toBeVisible()
  await page.getByTestId('panel-hide').click()
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('rail')).toBeVisible()
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await page.getByTestId('rail-show-list').click()
  await expect(page.getByTestId('trina-panel')).toBeVisible()
  await expect(page.getByTestId('rail-show-list')).toHaveCount(0)
  // wide again: always there, no hide button
  await page.setViewportSize({ width: 1280, height: 860 })
  await expect(page.getByTestId('panel-hide')).toHaveCount(0)
})

test('owner: the logo opens the team menu (Invite, Admin); the photo menu has status, away, Settings, Sign out, no Usage, Deleted history or Admin', async ({ page }) => {
  await start(page, 1280)
  await page.getByTestId('team-menu').click()
  await expect(page.getByTestId('team-menu-invite')).toBeVisible()
  await expect(page.getByTestId('team-menu-admin')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('team-dropdown')).toHaveCount(0)
  await expect(page.getByTestId('team-menu')).toBeFocused()
  await page.getByTestId('account-menu').click()
  const menu = page.getByTestId('account-dropdown')
  await expect(menu.getByTestId('account-who')).toContainText('Olga')
  await expect(menu.getByTestId('account-role')).toHaveText(t['role.owner'])
  for (const item of ['account-away', 'account-status', 'account-settings', 'logout']) await expect(menu.getByTestId(item)).toBeVisible()
  for (const item of ['account-usage', 'account-trash']) await expect(menu.getByTestId(item)).toHaveCount(0)
  await expect(menu).not.toContainText(t['sidebar.admin'])
})

test('member: the logo and team name are not a button; no Admin anywhere on the rail; same places', async ({ page }) => {
  await start(page, 1280, MEMBER)
  await expect(page.getByTestId('team-menu')).toHaveCount(0)
  await expect(page.getByTestId('team-header')).toContainText('Acme')
  await expect(page.getByTestId('rail')).not.toContainText(t['sidebar.admin'])
  await page.getByTestId('account-menu').click()
  await expect(page.getByTestId('account-role')).toHaveText(t['role.member'])
  await page.keyboard.press('Escape')
  for (const item of ['chats', 'files', 'activity', 'ai'] as const) await openRail(page, item)
})

test('Admin: no place lit, one 240 px menu beside the rail at every computer width (its icon rail gone)', async ({ page }) => {
  await start(page, 1024)
  await page.goto('/admin/members')
  await expect(page.getByTestId('admin-sidebar')).toBeVisible()
  await expect(page.getByTestId('admin-sidebar')).not.toHaveAttribute('data-rail', '')
  expect(await width(page, 'admin-sidebar')).toBe(240)
  await expect(page.getByTestId('rail').locator('[aria-current="page"]')).toHaveCount(0)
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
})

test('keyboard: skip links to the page and to the list; Tab goes logo → places → photo; arrows move between them', async ({ page }) => {
  await start(page, 1440)
  await page.keyboard.press('Tab')
  await expect(page.getByText(t['a11y.skip'])).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('skip-list')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('trina-panel')).toBeFocused()
  await page.getByTestId('team-menu').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('rail-ai')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('rail-chats')).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByTestId('account-menu')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(page.getByTestId('team-menu')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('account-menu')).toBeFocused()
  // ⇧⌘O: a new AI chat, 트리나 lit
  await openRail(page, 'files')
  await page.keyboard.press('Control+Shift+O')
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
})

test('⌘K: 대화 🔍 searches conversations; "프로젝트", "사용량" and "팀 폴더" are found', async ({ page }) => {
  await start(page, 1440)
  await openRail(page, 'chats')
  await page.getByTestId('chats-panel-search').click()
  await expect(page.getByTestId('search-tab-rooms')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+K')
  const input = page.getByRole('dialog').getByRole('combobox').or(page.getByRole('dialog').getByRole('textbox')).first()
  await input.fill(t['sidebar.projects'])
  await expect(page.getByRole('dialog').getByText(t['sidebar.projects'], { exact: true }).first()).toBeVisible()
  await input.fill(t['sidebar.usage'])
  await expect(page.getByRole('dialog').getByText(t['sidebar.usage'], { exact: true }).first()).toBeVisible()
  await input.fill(t['files.root'])
  await expect(page.getByRole('dialog').getByText(t['search.openFiles'], { exact: true })).toBeVisible()
})

test('Screenshots of the rail: each place at 1440 light and dark, 1280 light, 1024 with a thread open; owner and member', async ({ browser }) => {
  test.skip(!process.env.SHOTS, 'only with SHOTS=1')
  test.setTimeout(240_000)
  const dir = process.env.SHOTS_DIR ?? 'test-results/rail'
  for (const [role, who] of [['owner', undefined], ['member', MEMBER]] as const) {
    for (const [name, w, scheme] of [['1440-light', 1440, 'light'], ['1440-dark', 1440, 'dark'], ['1280-light', 1280, 'light']] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 860 }, colorScheme: scheme, locale: 'ko-KR' })
      const page = await ctx.newPage()
      await roomWithThread(page)
      await routeNotices(page, 4, 1)
      await start(page, w, who)
      for (const title of ['주간 보고 초안', '회의록 정리', '고객 문의 답장']) await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title } })
      await page.reload()
      await expect(page.getByTestId('rail')).toBeVisible()
      for (const item of ['ai', 'chats', 'files', 'activity'] as const) {
        if (name === '1280-light' && item !== 'ai') continue
        await openRail(page, item)
        await page.waitForTimeout(400)
        await page.screenshot({ path: `${dir}/${role}-${item}-${name}.png` })
      }
      if (name === '1440-light') {
        await page.getByTestId('account-menu').click()
        await page.screenshot({ path: `${dir}/${role}-me-menu-${name}.png` })
        await page.keyboard.press('Escape')
        if (role === 'owner') {
          await page.getByTestId('team-menu').click()
          await page.screenshot({ path: `${dir}/${role}-team-menu-${name}.png` })
          await page.keyboard.press('Escape')
        }
      }
      await ctx.close()
    }
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: 'light', locale: 'ko-KR' })
    const page = await ctx.newPage()
    await roomWithThread(page)
    await start(page, 1024, who)
    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
    await expect(page.getByTestId('room-thread')).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/${role}-thread-1024-light.png` })
    await ctx.close()
  }
})

test('a phone keeps today\'s layout with the switch on (its tabs are a later phase)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await expect(page.getByTestId('bottom-tabs')).toBeVisible()
  await expect(page.getByTestId('rail')).toHaveCount(0)
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await page.goto('/rooms')
  await expect(page.getByTestId('rooms-pick')).toHaveCount(0)
})
