// How a test moves around the app (docs/AGENTS/plan/20261112-1839-nav-rail.md, phases P6–P7): the rail with one list
// panel at a time on computers (트리나 · 대화 · 파일 · 활동; the team's logo on top, my photo at the bottom) and the phone's
// tabs 트리나 · 대화 · 파일 · 나 (the 트리나 tab is the list, its floating "트리나에게 묻기" opens /new).
//
// A spec never uses a navigation selector itself (no `rail-*`, panel, `sidebar-*`, `recents-*`, `trina-*` or `tab-*`
// ids): it asks here, and this file is the one place that knows where each thing is. When an id changes, adapt it here.
import { expect, type Locator, type Page } from '@playwright/test'

export type Place = 'trina' | 'chats' | 'files' | 'activity'

/** the rail's ids (lib/rail.ts RailItem) */
const RAIL: Record<Place, 'ai' | 'chats' | 'files' | 'activity'> = { trina: 'ai', chats: 'chats', files: 'files', activity: 'activity' }

/** below 768 px the app is the phone's layout (components/Layout.tsx) */
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1360) < 768

// ---------------------------------------------------------------------------------------------------------------------
// computers: the rail and its panels

/** The rail's button of a place. */
export const railButton = (page: Page, place: Place) => page.getByTestId(`rail-${RAIL[place]}`)

/** The list panel of a place beside the rail (components/panels/*). */
export const panel = (page: Page, place: Place) => page.getByTestId(place === 'trina' ? 'trina-panel' : place === 'chats' ? 'chats-panel' : place === 'files' ? 'files-panel' : 'activity-panel')

/** Make a place the lit one so its list shows (a press on the rail only when another place is lit: pressing the lit
 * one would go to its start); a list hidden by its own button (below 1052 px) comes back. Returns its panel. */
export async function showPanel(page: Page, place: Place): Promise<Locator> {
  const button = railButton(page, place)
  await expect(button).toBeVisible()
  if ((await button.getAttribute('aria-current')) !== 'page') await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
  const show = page.getByTestId('rail-show-list')
  if (await show.isVisible()) await show.click()
  const p = panel(page, place)
  await expect(p).toBeVisible()
  return p
}

// ---------------------------------------------------------------------------------------------------------------------
// phones: the tabs

/** A phone's tab: 트리나 · 대화 · 파일 · 나. */
export type PhoneTab = 'ai' | 'chats' | 'files' | 'me'

/** The tab that holds a place (to check it is the lit one): projects are in the 트리나 tab. The 나 list draws its own
 * bar over the page's: the last one is the one on show. */
export const tabButton = (page: Page, which: PhoneTab | 'projects') => page.getByTestId(`tab-${which === 'projects' ? 'ai' : which}`).last()

/** Press a phone tab. The bar shows on a tab's root and its pages, not on /new, inside a room or a chat: from there the
 * page's ‹ first, as a person does. */
export async function openTab(page: Page, tab: PhoneTab) {
  const button = tabButton(page, tab)
  const back = page.getByTestId('topbar-back').or(page.getByTestId('chat-back')).or(page.getByTestId('room-back')).first()
  for (let i = 0; i < 3 && !(await button.isVisible()) && (await back.isVisible()); i++) await back.click()
  await button.click()
}

/** The tab bar itself (to check it shows or hides). */
export const tabBar = (scope: Page | Locator) => scope.getByTestId('bottom-tabs')

/** A phone tab's mark (its count or "?"). */
export const tabMark = (page: Page, tab: PhoneTab) => page.getByTestId(`tab-${tab}-unread`)

/** The mark for the AI chats on a phone: on the 트리나 tab. */
export const phoneAiMark = (page: Page) => page.getByTestId('tab-ai-mark')

/** The 트리나 tab's root: its list and the floating "트리나에게 묻기". */
export const phoneTrinaHome = (page: Page) => page.getByTestId('phone-trina-home')

/** The projects list on a phone: the 트리나 tab's "모든 프로젝트". */
export async function openProjectsTab(page: Page) {
  await openTab(page, 'ai')
  await allProjects(page, phoneTrinaHome(page))
  await expect(page).toHaveURL(/\/projects$/)
}

/** The 트리나 list's way to every project: "모든 프로젝트 (N)"; with no project yet the list draws no such row, and the
 * projects page is where "+ 새 프로젝트" leads. */
async function allProjects(page: Page, scope: Locator) {
  const all = scope.getByTestId('trina-all-projects')
  await expect(all.or(scope.getByTestId('trina-new-project')).first()).toBeVisible()
  if (await all.isVisible()) await all.click()
  else await page.goto('/projects')
}

// ---------------------------------------------------------------------------------------------------------------------
// places and their lists

/** Go to a place the way a person does: the rail on a computer; a phone's tab (활동: 나 › 활동). */
export async function openPlace(page: Page, place: Place) {
  if (isPhone(page)) {
    if (place === 'activity') {
      await openTab(page, 'me')
      await page.getByTestId('settings-inbox').click()
      return
    }
    await openTab(page, place === 'trina' ? 'ai' : place)
    return
  }
  const button = railButton(page, place)
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
}

/** "트리나에게 묻기": a new AI chat, waiting for its message box. */
export async function openNewChat(page: Page) {
  await (await newChatButton(page)).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

/** The "트리나에게 묻기" button, its list shown first (the 트리나 panel's top row; the 트리나 tab's floating button). */
export async function newChatButton(page: Page): Promise<Locator> {
  if (isPhone(page)) {
    await openTab(page, 'ai')
    return phoneTrinaHome(page).getByTestId('new-chat')
  }
  return (await showPanel(page, 'trina')).getByTestId('new-chat')
}

/** Search (⌘K's palette): the 트리나 panel's 검색, the 트리나 tab's 🔍. */
export async function openSearch(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'ai')
    await phoneTrinaHome(page).getByTestId('topbar-search').click()
    return
  }
  await (await showPanel(page, 'trina')).getByTestId('nav-search').click()
}

/** The 트리나 list's own rows: 예약 작업, 팀 스킬, 삭제한 기록 at its end, and 모든 프로젝트. */
export async function openTrinaRow(page: Page, row: 'scheduled' | 'skills' | 'trash' | 'projects') {
  if (isPhone(page)) {
    if (row === 'projects') return openProjectsTab(page)
    await openTab(page, 'ai')
    await phoneTrinaHome(page).getByTestId(`nav-${row}`).click()
    return
  }
  const p = await showPanel(page, 'trina')
  if (row === 'projects') await allProjects(page, p)
  else await p.getByTestId(`nav-${row}`).click()
}

/** One of those rows (to check it is the lit one). */
export async function trinaRowLink(page: Page, row: 'scheduled' | 'skills' | 'trash'): Promise<Locator> {
  if (isPhone(page)) {
    await openTab(page, 'ai')
    return phoneTrinaHome(page).getByTestId(`nav-${row}`)
  }
  return (await showPanel(page, 'trina')).getByTestId(`nav-${row}`)
}

/** Show the AI's history (the 트리나 panel; the 트리나 tab's list). Then `navChatList`, `navChatRow`. */
export async function showChats(page: Page) {
  if (isPhone(page)) await openTab(page, 'ai')
  else await showPanel(page, 'trina')
}

/** The AI's history list (`showChats` first): the Trina list, or its filtered view while a filter is on. Chat rows
 * inside are `li` with a link to `/c/<id>`. */
export const navChatList = (page: Page) => page.getByTestId('trina-list').or(page.getByTestId('recents-list'))

/** One chat's row there, by its id or its title. */
export const navChatRow = (page: Page, chat: { id: string } | { title: string | RegExp }) =>
  'id' in chat ? navChatList(page).locator('li', { has: page.locator(`a[href="/c/${chat.id}"]`) }).first() : navChatList(page).locator('li', { hasText: chat.title }).first()

/** `showChats` and the list, in one step. */
export async function chatList(page: Page): Promise<Locator> {
  await showChats(page)
  return navChatList(page)
}

/** `showChats` and one chat's row, in one step. */
export async function chatRow(page: Page, chat: { id: string } | { title: string | RegExp }): Promise<Locator> {
  await showChats(page)
  return navChatRow(page, chat)
}

/** The pinned chats' rows in the AI's history (the 트리나 list's 고정 section; most recently pinned first). */
export const pinnedChats = (page: Page) => navChatList(page).locator('li[data-pinned]')

/** The history's filter (status, last activity, group by, sort): the 트리나 panel's header button, the 트리나 tab's.
 * Opens its menu; its items are `recents-view-*` and `recents-<view>-<choice>`. */
export async function openChatFilter(page: Page) {
  await showChats(page)
  await (isPhone(page) ? phoneTrinaHome(page) : panel(page, 'trina')).getByTestId('recents-filter').first().click()
}

/** The filter's "reset" (shown while a filter is on). */
export const chatFilterClear = (page: Page) => page.getByTestId('recents-filter-clear')

/** The list panel on a computer (a navigation landmark named by its title), shown: for "it shows up in the list". */
export async function navLists(page: Page, place: Place = 'trina'): Promise<Locator> {
  return showPanel(page, place)
}

/** Where the navigation ends on a computer: the right edge of the rail, or of its list panel while one shows (a big
 * side panel or the page fills what is right of it). */
export const navRight = (page: Page) =>
  page.evaluate(() => Math.round(Math.max(...[document.querySelector('[data-testid="rail"]'), document.getElementById('rail-panel')].map((e) => e?.getBoundingClientRect().right ?? 0))))

/** The navigation's top on a computer (to check it stays put): the rail. */
export const navTop = (page: Page) => page.getByTestId('rail')

// ---------------------------------------------------------------------------------------------------------------------
// rooms

/** Show the rooms list on a computer: the 대화 panel (no cap). A phone's 대화 list is the 대화 tab's page. */
export async function showRooms(page: Page) {
  if (isPhone(page)) {
    if (!(await page.getByTestId('rooms-page').isVisible())) await openTab(page, 'chats')
    return
  }
  await showPanel(page, 'chats')
}

/** The computer's rooms list in the 대화 panel (`showRooms` first). */
export const navRoomsList = (page: Page) => page.getByTestId('sidebar-rooms-list')
/** Its rows, each with the room's link and its "⋯" (`roomRowLink`, `roomRowMenu`). */
export const navRoomRows = (page: Page) => page.getByTestId('sidebar-room-row')
/** One room's row in it, by its name. */
export const navRoomRow = (page: Page, name: string | RegExp) => navRoomRows(page).filter({ hasText: name })
/** The links of its rows (one per room, in the list's order). */
export const navRoomLinks = (page: Page) => page.getByTestId('sidebar-room')
/** The link of a row (what a click opens; its accessible name has the presence and status words). */
export const roomRowLink = (row: Locator) => row.getByTestId('sidebar-room')
/** The "⋯" of a row. */
export const roomRowMenu = (row: Locator) => row.getByTestId('sidebar-room-menu')

/** Open a room from the rooms list, as a person does (a phone: the 대화 tab's row). */
export async function openRoom(page: Page, name: string | RegExp) {
  await showRooms(page)
  if (isPhone(page)) await page.getByTestId('rooms-row').filter({ hasText: name }).first().click()
  else await roomRowLink(navRoomRow(page, name).first()).click()
  await expect(page).toHaveURL(/\/rooms\/[^/]+/)
}

/** "새 대화" (the people picker): the 대화 panel's ⊕, the 대화 tab's ⊕. */
export async function openNewConversation(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'chats')
    await page.getByTestId('topbar-new-dm').click()
    return
  }
  await (await showPanel(page, 'chats')).getByTestId('rooms-new-dm').click()
}

/** 멘션·스레드: the 대화 panel's row (a computer), the 대화 tab's row (a phone). */
export async function openMentions(page: Page) {
  await showRooms(page)
  await (isPhone(page) ? page.getByTestId('rooms-page') : panel(page, 'chats')).getByTestId('rooms-activity').click()
  await expect(page).toHaveURL(/\/activity\?in=chats/)
}

// ---------------------------------------------------------------------------------------------------------------------
// 파일 and 활동

/** A place of the 파일 list: 최근 파일, the team folder's top, 내 파일, 휴지통 (the 파일 panel's rows; a phone: the 파일
 * tab, then the page by its address). */
export async function openFilesPlace(page: Page, where: 'recent' | 'root' | 'mine' | 'trash') {
  if (isPhone(page)) {
    await openTab(page, 'files')
    if (where === 'trash') await page.goto('/files?view=trash')
    else if (where === 'root') await page.goto('/files')
    return
  }
  await (await showPanel(page, 'files')).getByTestId(where === 'root' ? 'files-panel-root' : `files-panel-${where}`).click()
}

/** The 활동 list's notice rows (the 활동 panel beside the rail). */
export async function activityRows(page: Page): Promise<Locator> {
  return (await showPanel(page, 'activity')).getByTestId('activity-panel-row')
}

/** Open a notice from 활동 as a person does and return it as the page shows it (`notification-item`, with its buttons):
 * on a computer the 활동 panel's row, which opens it beside the list (one with buttons of its own, a handover's or an
 * ask's, opens as itself: `/activity?n=<id>`); on a phone the 활동 page, where each notice is its whole row. */
export async function openNotice(page: Page, text: string | RegExp): Promise<Locator> {
  if (isPhone(page)) {
    await page.goto('/activity')
    return page.getByTestId('notification-item').filter({ hasText: text })
  }
  await (await activityRows(page)).filter({ hasText: text }).first().click()
  return page.getByTestId('activity-opened').getByTestId('notification-item')
}

/** The 활동 count: the rail's 활동 mark; on a phone the 나 tab's. It leaves out mentions, threads and DMs (they are 대화's). */
export const activityCount = (page: Page) => page.getByTestId(isPhone(page) ? 'tab-me-unread' : 'rail-activity-mark')

// ---------------------------------------------------------------------------------------------------------------------
// me and the team

/** My photo's menu at the bottom of the rail: returns it open. Computers only (a phone's is the 나 tab). */
export async function openAccountMenu(page: Page): Promise<Locator> {
  await accountButton(page).click()
  const menu = page.getByTestId('account-dropdown')
  await expect(menu).toBeVisible()
  return menu
}

/** My photo itself (its status emoji, its focus). */
export const accountButton = (page: Page) => page.getByTestId('account-menu')

/** The Settings dialog ("설정" on a computer, the 나 tab on a phone). */
// the dialog itself (on a phone an open section draws its own bar, without the list's settings-title)
export const settingsDialog = (page: Page) => page.getByTestId('settings-dialog')

/** Settings: my photo's menu › 설정 on a computer, the 나 tab on a phone. */
export async function openSettings(page: Page) {
  if (isPhone(page)) await openTab(page, 'me')
  else await (await openAccountMenu(page)).getByTestId('account-settings').click()
  await expect(settingsDialog(page)).toBeVisible()
}

/** My usage: Settings › 사용량 (the photo's menu has no row of its own). */
export async function openUsage(page: Page) {
  await page.goto('/settings/usage')
}

/** My status row on a phone: the 나 tab's. */
export async function myStatusRow(page: Page): Promise<Locator> {
  await openTab(page, 'me')
  return page.getByTestId('settings-status')
}

/** "상태 설정": the photo's menu item on a computer, the 나 tab's row on a phone. */
export async function openStatusDialog(page: Page) {
  if (isPhone(page)) await (await myStatusRow(page)).click()
  else await (await openAccountMenu(page)).getByTestId('account-status').click()
}

/** Sign out: the photo's menu › 로그아웃 (a computer), the 나 tab's last row and its confirm (a phone). */
export async function signOut(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'me')
    await page.getByTestId('settings-logout').click()
    const confirm = page.getByTestId('dialog-confirm')
    await expect(confirm.or(page.getByTestId('login-username')).first()).toBeVisible()
    if (await confirm.isVisible()) await confirm.click()
  } else await (await openAccountMenu(page)).getByTestId('logout').click()
  await expect(page.getByTestId('login-username')).toBeVisible()
}

/** The team menu (the logo on top of the rail) of an owner or admin: returns it open. */
export async function openTeamMenu(page: Page): Promise<Locator> {
  await teamMenuButton(page).click()
  const menu = page.getByTestId('team-dropdown')
  await expect(menu).toBeVisible()
  return menu
}

/** The team menu's button itself (to check a member has none). */
export const teamMenuButton = (page: Page) => page.getByTestId('team-menu')
/** A member's plain team header (no menu): the logo and the name. */
export const teamHeader = (page: Page) => page.getByTestId('team-header')
/** The team's logo on top of the rail (36 px). */
export const teamLogo = (page: Page) => page.getByTestId('sidebar-logo')

/** Admin: the team menu's 관리자 on a computer, 나 › 관리자 on a phone. */
export async function openAdmin(page: Page) {
  if (isPhone(page)) {
    await openTab(page, 'me')
    await page.getByTestId('settings-admin').click()
  } else await (await openTeamMenu(page)).getByTestId('team-menu-admin').click()
  await expect(page).toHaveURL(/\/admin/)
}
