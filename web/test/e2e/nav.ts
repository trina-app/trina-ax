// How a test moves around the app, in both navigations (docs/AGENTS/plan/20261112-1839-nav-rail.md §5.1, phase P6): the
// sidebar and the phone's drawer and tabs of today, and the new navigation behind the server's `navRail` switch (the rail
// with one list panel on computers, phases P1–P4b; the phone's tabs 트리나 · 대화 · 파일 · 나, phase P5).
//
// A spec never uses a navigation selector itself (no `nav-*`, `sidebar-*`, `recents-*`, `menu-open`, `tab-*` or rail
// ids): it asks here, and this file is the one place that knows where each thing is in each navigation. When a phase
// changes an id, adapt it here.
//
// Which navigation a page shows is the server's answer (GET /api/me `server.navRail`), the same thing the layout reads.
// The whole run can be put in the new navigation with `MOCK_NAV_RAIL=1` (the mock's switch after every reset,
// web/test/mock/server.ts); `navRail(page, on)` in helpers.ts still turns it on or off for one test (sign in or reload
// after it). Specs that test the old sidebar itself call `oldNav(page)` after their reset.
import { expect, type Locator, type Page } from '@playwright/test'
import { navRail } from './helpers'

export type Place = 'trina' | 'chats' | 'files' | 'activity'

/** the rail's ids (lib/rail.ts RailItem) */
const RAIL: Record<Place, 'ai' | 'chats' | 'files' | 'activity'> = { trina: 'ai', chats: 'chats', files: 'files', activity: 'activity' }

/** below 768 px the app is the phone's layout (components/Layout.tsx) */
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1360) < 768

/** whether this page is in the new navigation: the server's switch, as the app reads it from GET /api/me */
export async function isNewNav(page: Page): Promise<boolean> {
  const r = await page.request.get('/api/me')
  if (!r.ok()) return false
  const me = (await r.json().catch(() => null)) as { server?: { navRail?: boolean } } | null
  return me?.server?.navRail === true
}

/** For specs of the old sidebar, drawer or tabs themselves (they go with phase P7): turn the switch off whatever the run
 * says. Call it after reset() and before signing in. */
export async function oldNav(page: Page) {
  await navRail(page, false)
}

// ---------------------------------------------------------------------------------------------------------------------
// computers

/** The rail's button of a place (new navigation only). */
const railButton = (page: Page, place: Place) => page.getByTestId(`rail-${RAIL[place]}`)

/** The list panel of a place beside the rail (new navigation only; components/panels/*). */
const panel = (page: Page, place: Place) => page.getByTestId(place === 'trina' ? 'trina-panel' : place === 'chats' ? 'chats-panel' : place === 'files' ? 'files-panel' : 'activity-panel')

/** New navigation on a computer: make a place the lit one so its list shows (a press on the rail only when another
 * place is lit: pressing the lit one would go to its start). Returns its panel. */
async function showPanel(page: Page, place: Place): Promise<Locator> {
  const button = railButton(page, place)
  await expect(button).toBeVisible()
  if ((await button.getAttribute('aria-current')) !== 'page') await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
  // a panel hidden by its own button (below 1052 px) comes back
  const show = page.getByTestId('rail-show-list')
  if (await show.isVisible()) await show.click()
  const p = panel(page, place)
  await expect(p).toBeVisible()
  return p
}

// ---------------------------------------------------------------------------------------------------------------------
// phones

/** A phone's tab. Today's tabs: 트리나 · 대화 · 프로젝트 · 나; the new ones (phase P5): 트리나 · 대화 · 파일 · 나. */
export type PhoneTab = 'ai' | 'chats' | 'files' | 'me'

/** Press a phone tab (the tab bar shows on a tab's root and its pages, not inside a room or a chat). In the old tabs
 * 파일 is the 프로젝트 tab's team-folder row. */
export async function openTab(page: Page, tab: PhoneTab) {
  const neu = await isNewNav(page)
  if (tab === 'files' && !neu) {
    await page.getByTestId('tab-projects').click()
    await page.getByTestId('projects-team-folder-row').click()
    return
  }
  await page.getByTestId(`tab-${tab}`).click()
}

/** The tab bar itself (to check it shows or hides). */
export const tabBar = (page: Page) => page.getByTestId('bottom-tabs')

/** The phone's ☰ drawer of today (the 트리나 tab's history). Old navigation only: the new phone tabs have none. */
export async function openDrawer(page: Page): Promise<Locator> {
  await page.getByTestId('menu-open').click()
  const drawer = page.locator('[data-drawer]')
  await expect(drawer).toBeVisible()
  return drawer
}

/** The ☰ button of today's phone top bar (to check it shows, hides or carries a mark). Old navigation only. */
export const drawerButton = (page: Page) => page.getByTestId('menu-open')

// ---------------------------------------------------------------------------------------------------------------------
// places and their lists

/** Go to a place the way a person does: the rail on a computer with the new navigation, today's sidebar row (트리나:
 * Home, 대화: the rooms page, 파일, 활동/알림함), a phone's tab (활동: 나 › 활동). */
export async function openPlace(page: Page, place: Place) {
  const neu = await isNewNav(page)
  if (isPhone(page)) {
    if (place === 'activity') {
      await openTab(page, 'me')
      await page.getByTestId(neu ? 'me-activity' : 'settings-inbox').click()
      return
    }
    await openTab(page, place === 'trina' ? 'ai' : place)
    return
  }
  if (neu) {
    const button = railButton(page, place)
    await button.click()
    await expect(button).toHaveAttribute('aria-current', 'page')
    return
  }
  if (place === 'trina') await page.getByTestId('new-chat').click()
  else if (place === 'chats') await page.goto('/rooms')
  else await page.getByTestId(place === 'files' ? 'nav-files' : 'nav-inbox').click()
}

/** "트리나에게 묻기": a new AI chat, waiting for its message box. */
export async function openNewChat(page: Page) {
  const neu = await isNewNav(page)
  if (isPhone(page)) {
    await openTab(page, 'ai')
    if (neu) await page.getByTestId('phone-ask-ai').click()
  } else await (neu ? await showPanel(page, 'trina') : page).getByTestId('new-chat').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

/** The "트리나에게 묻기" row itself (to read its words, size or focus), its list shown first. */
export async function newChatButton(page: Page): Promise<Locator> {
  if (!isPhone(page) && (await isNewNav(page))) return (await showPanel(page, 'trina')).getByTestId('new-chat')
  return page.getByTestId('new-chat')
}

/** Search (the palette, ⌘K's): the 트리나 list's 검색 on a computer, the top bar's 🔍 (today: ☰ › 검색) on a phone. */
export async function openSearch(page: Page) {
  const neu = await isNewNav(page)
  if (isPhone(page)) {
    if (neu) {
      await openTab(page, 'ai')
      await page.getByTestId('topbar-search').click()
    } else {
      const drawer = await openDrawer(page)
      await drawer.getByTestId('drawer-search').click()
    }
    return
  }
  await (neu ? await showPanel(page, 'trina') : page).getByTestId('nav-search').click()
}

/** The quiet rows of the 트리나 list (today: sidebar rows; 삭제한 기록 is the account menu's on a computer and the
 * drawer's on a phone). */
export async function openTrinaRow(page: Page, row: 'scheduled' | 'skills' | 'trash' | 'projects') {
  const neu = await isNewNav(page)
  if (isPhone(page)) {
    if (row === 'projects') {
      if (neu) {
        await openTab(page, 'ai')
        await page.getByTestId('trina-all-projects').click()
      } else await page.getByTestId('tab-projects').click()
      return
    }
    if (neu) {
      await openTab(page, 'ai')
      await page.getByTestId(`nav-${row}`).click()
    } else await (await openDrawer(page)).getByTestId(`nav-${row}`).click()
    return
  }
  if (neu) {
    await (await showPanel(page, 'trina')).getByTestId(row === 'projects' ? 'trina-all-projects' : `nav-${row}`).click()
    return
  }
  if (row === 'trash') {
    await page.getByTestId('account-menu').click()
    await page.getByTestId('account-trash').click()
    return
  }
  await page.getByTestId(`nav-${row}`).click()
}

/** The row of a 트리나 list item (to check it is the lit one): the sidebar's row today, the 트리나 panel's in the new
 * navigation. */
export async function trinaRowLink(page: Page, row: 'scheduled' | 'skills' | 'trash'): Promise<Locator> {
  if (!isPhone(page) && (await isNewNav(page))) return (await showPanel(page, 'trina')).getByTestId(`nav-${row}`)
  return page.getByTestId(`nav-${row}`)
}

/** The AI's history list, shown: the sidebar's 트리나 기록 (today; on a phone the ☰ drawer), the 트리나 panel (new, on a
 * computer) or the 트리나 tab's list (new, on a phone). Chat rows inside are `li` with a link to `/c/<id>`. */
export async function chatList(page: Page): Promise<Locator> {
  const neu = await isNewNav(page)
  if (isPhone(page)) {
    if (neu) {
      await openTab(page, 'ai')
      return page.getByTestId('trina-list')
    }
    const drawer = page.locator('[data-drawer]')
    if (!(await drawer.isVisible())) await openDrawer(page)
    return drawer.getByTestId('recents-list')
  }
  if (neu) return (await showPanel(page, 'trina')).getByTestId('trina-list')
  return page.getByTestId('recents-list')
}

/** One chat's row in the AI's history list (shown first). */
export async function chatRow(page: Page, chat: { id: string } | { title: string | RegExp }): Promise<Locator> {
  const list = await chatList(page)
  return 'id' in chat ? list.locator('li', { has: page.locator(`a[href="/c/${chat.id}"]`) }).first() : list.locator('li', { hasText: chat.title }).first()
}

/** The navigation landmark that holds the lists (the sidebar today; the list panel beside the rail): for "the chat
 * shows up in the navigation". Its list is shown first. */
export async function navLists(page: Page, place: Place = 'trina'): Promise<Locator> {
  if (!isPhone(page) && (await isNewNav(page))) return showPanel(page, place)
  return page.getByRole('navigation').filter({ has: page.getByTestId('sidebar-scroll') })
}

/** The rooms list, shown: the sidebar's 대화 section (today, capped at five plus the room on screen; `all` opens its
 * "더 보기"), the 대화 panel (new), or the phone's 대화 tab. Rows inside: `roomRow`. */
export async function roomsList(page: Page, o: { all?: boolean } = {}): Promise<Locator> {
  const neu = await isNewNav(page)
  if (isPhone(page)) {
    if (!(await page.getByTestId('rooms-page').isVisible())) await openTab(page, 'chats')
    return page.getByTestId('rooms-page')
  }
  if (neu) return (await showPanel(page, 'chats')).getByTestId('sidebar-rooms-list')
  const list = page.getByTestId('sidebar-rooms-list')
  const more = page.getByTestId('rooms-more')
  if (o.all && (await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  return list
}

/** A room's row in the rooms list (the whole row with its "⋯"; on a phone the 대화 tab's row). */
export async function roomRow(page: Page, name: string | RegExp, o: { all?: boolean } = {}): Promise<Locator> {
  const list = await roomsList(page, o)
  return list.getByTestId(isPhone(page) ? 'rooms-row' : 'sidebar-room-row').filter({ hasText: name })
}

/** The link of a room's row (what a click opens; its accessible name has the presence and status words). */
export async function roomLink(page: Page, name: string | RegExp, o: { all?: boolean } = {}): Promise<Locator> {
  const row = await roomRow(page, name, o)
  return isPhone(page) ? row.getByRole('link').first() : row.getByTestId('sidebar-room')
}

/** The "⋯" of a room's row. */
export async function roomRowMenu(page: Page, name: string | RegExp): Promise<Locator> {
  const row = await roomRow(page, name)
  return row.getByTestId(isPhone(page) ? 'rooms-row-menu' : 'sidebar-room-menu')
}

/** Open a room from the rooms list, as a person does. */
export async function openRoom(page: Page, name: string | RegExp) {
  await (await roomLink(page, name, { all: true })).click()
  await expect(page).toHaveURL(/\/rooms\/[^/]+/)
}

/** "새 대화" (the people picker). */
export async function openNewConversation(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'chats')
    await page.getByTestId('topbar-new-dm').click()
    return
  }
  if (await isNewNav(page)) await showPanel(page, 'chats')
  await page.getByTestId('rooms-new-dm').click()
}

// ---------------------------------------------------------------------------------------------------------------------
// me and the team

/** My photo's menu (the rail's bottom, or the sidebar's account line): returns the open menu. Computers only; a phone's
 * account things are the 나 tab. */
export async function openAccountMenu(page: Page): Promise<Locator> {
  await page.getByTestId('account-menu').click()
  const menu = page.getByTestId('account-dropdown')
  await expect(menu).toBeVisible()
  return menu
}

/** My account button itself (the rail's photo or the sidebar's account line: its status emoji, its focus). */
export const accountButton = (page: Page) => page.getByTestId('account-menu')

/** Settings (the dialog): the account menu's 설정 on a computer, the 나 tab on a phone. */
export async function openSettings(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'me')
    return
  }
  await (await openAccountMenu(page)).getByTestId('account-settings').click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

/** My usage: the account menu's 사용량 today; Settings › 사용량 in the new navigation (the rail's menu has no row). */
export async function openUsage(page: Page) {
  if (!isPhone(page) && !(await isNewNav(page))) {
    await (await openAccountMenu(page)).getByTestId('account-usage').click()
    return
  }
  await page.goto('/settings/usage')
}

/** "상태 설정": the account menu's item on a computer (the dialog opens); on a phone the drawer's status row today, the
 * 나 tab's in the new tabs. */
export async function openStatusDialog(page: Page) {
  if (isPhone(page)) {
    if (await isNewNav(page)) {
      await openTab(page, 'me')
      await page.getByTestId('my-status-row').click()
    } else await (await openDrawer(page)).getByTestId('my-status-row').click()
    return
  }
  await (await openAccountMenu(page)).getByTestId('account-status').click()
}

/** Sign out: the account menu's 로그아웃 (a computer) or the 나 tab's last row (a phone). */
export async function signOut(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'me')
    await page.getByTestId('settings-logout').click()
  } else await (await openAccountMenu(page)).getByTestId('logout').click()
  await expect(page.getByTestId('login-username')).toBeVisible()
}

/** The team menu (the team's logo: the rail's top, or the sidebar's header) of an owner or admin: returns it open. */
export async function openTeamMenu(page: Page): Promise<Locator> {
  await page.getByTestId('team-menu').click()
  const menu = page.getByTestId('team-dropdown')
  await expect(menu).toBeVisible()
  return menu
}

/** The team menu's button itself (to check a member has none). */
export const teamMenuButton = (page: Page) => page.getByTestId('team-menu')

/** Admin: the team menu's 관리자 on a computer, 나 › 관리자 on a phone. */
export async function openAdmin(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'me')
    await page.getByTestId('settings-admin').click()
  } else await (await openTeamMenu(page)).getByTestId('team-menu-admin').click()
  await expect(page).toHaveURL(/\/admin/)
}

/** The 활동 count where navigation shows it (today: the sidebar's 알림함 row; new: the rail's 활동 mark; phone: the 나
 * tab). The two counts differ by design: the new 활동 leaves out mentions, threads and DMs (§2.1). */
export async function activityCount(page: Page): Promise<Locator> {
  if (isPhone(page)) return page.getByTestId('tab-me-unread')
  return page.getByTestId((await isNewNav(page)) ? 'rail-activity-mark' : 'inbox-unread')
}
