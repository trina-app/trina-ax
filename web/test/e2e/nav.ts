// How a test moves around the app (docs/AGENTS/plan/20261112-1839-nav-rail.md, phases P6–P7; docs/DECISIONS.md "Projects:
// a place of their own", "Phones: the 트리나 tab as before the redesign"): the rail with one list panel at a time on
// computers (트리나 · 대화 · 프로젝트 · 파일 · 활동; the team's logo on top, my photo at the bottom) and the phone's tabs
// 트리나 · 대화 · 프로젝트 · 파일 · 나 (the 트리나 tab is Home's message box, its ☰ opens the history drawer).
//
// A spec never uses a navigation selector itself (no `rail-*`, panel, `sidebar-*`, `recents-*`, `trina-*` or `tab-*`
// ids): it asks here, and this file is the one place that knows where each thing is. When an id changes, adapt it here.
import { expect, type Locator, type Page } from '@playwright/test'

export type Place = 'trina' | 'chats' | 'projects' | 'files' | 'activity'

/** the rail's ids (lib/rail.ts RailItem) */
const RAIL: Record<Place, 'ai' | 'chats' | 'projects' | 'files' | 'activity'> = { trina: 'ai', chats: 'chats', projects: 'projects', files: 'files', activity: 'activity' }

/** below 768 px the app is the phone's layout (components/Layout.tsx) */
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1360) < 768

// ---------------------------------------------------------------------------------------------------------------------
// computers: the rail and its panels

/** The rail's button of a place. */
export const railButton = (page: Page, place: Place) => page.getByTestId(`rail-${RAIL[place]}`)

/** The list panel of a place beside the rail (components/panels/*). */
export const panel = (page: Page, place: Place) => page.getByTestId(place === 'trina' ? 'trina-panel' : `${place}-panel`)

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

/** A phone's tab: 트리나 · 대화 · 프로젝트 · 파일 · 나. */
export type PhoneTab = 'ai' | 'chats' | 'projects' | 'files' | 'me'

/** A phone tab's button (to check it is the lit one). The 나 list draws its own bar over the page's: the last one is
 * the one on show. */
export const tabButton = (page: Page, which: PhoneTab) => page.getByTestId(`tab-${which}`).last()

/** Press a phone tab. The bar shows on a tab's root and its pages, not inside a room or a chat: from there the page's ‹
 * first, as a person does. */
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

/** The 트리나 tab's history drawer (☰ on Home, components/phone/TrinaDrawer.tsx): 검색, 예약 작업, 팀 스킬, the history,
 * my status and 삭제한 기록. `phoneTrinaHome` opens it. */
export const phoneDrawer = (page: Page) => page.getByTestId('trina-drawer')

/** The 트리나 tab with its drawer open (Home's ☰): returns the drawer. */
export async function phoneTrinaHome(page: Page): Promise<Locator> {
  const drawer = phoneDrawer(page)
  if (await drawer.isVisible()) return drawer
  const menu = page.getByTestId('menu-open')
  if (!(await menu.isVisible())) await openTab(page, 'ai')
  await menu.click()
  await expect(drawer).toBeVisible()
  return drawer
}

/** The projects list on a phone: the 프로젝트 tab. */
export async function openProjectsTab(page: Page) {
  await openTab(page, 'projects')
  await expect(page).toHaveURL(/\/projects$/)
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

/** "트리나에게 묻기": a new AI chat, waiting for its message box (a phone: the 트리나 tab, Home's box itself). */
export async function openNewChat(page: Page) {
  if (isPhone(page)) await openTab(page, 'ai')
  else await (await newChatButton(page)).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

/** The "트리나에게 묻기" button, its list shown first (the 트리나 panel's top row). Computers only: a phone's 트리나 tab is
 * the new chat's box itself. */
export async function newChatButton(page: Page): Promise<Locator> {
  return (await showPanel(page, 'trina')).getByTestId('new-chat')
}

/** Search (⌘K's palette): the 트리나 panel's 검색, the 트리나 tab's drawer's 검색. */
export async function openSearch(page: Page) {
  if (isPhone(page)) {
    await (await phoneTrinaHome(page)).getByTestId('drawer-search').click()
    return
  }
  await (await showPanel(page, 'trina')).getByTestId('nav-search').click()
}

/** The AI's own pages: 예약 작업 and 팀 스킬 (the 트리나 panel's top; the drawer's), 삭제한 기록 (최근 기록's "⋯" on a
 * computer; the drawer's last row on a phone), and every project ('projects': 프로젝트's own place, the rail or the tab). */
export async function openTrinaRow(page: Page, row: 'scheduled' | 'skills' | 'trash' | 'projects') {
  if (row === 'projects') {
    if (isPhone(page)) await openProjectsTab(page)
    else await showPanel(page, 'projects')
    return
  }
  if (isPhone(page)) {
    await (await phoneTrinaHome(page)).getByTestId(`nav-${row}`).click()
    return
  }
  const p = await showPanel(page, 'trina')
  if (row === 'trash') {
    await p.getByTestId('trina-recent-menu').click()
    await page.getByTestId('nav-trash').click()
  } else await p.getByTestId(`nav-${row}`).click()
}

/** 예약 작업's or 팀 스킬's row (to check it is the lit one): the 트리나 panel's, a phone's drawer's. */
export async function trinaRowLink(page: Page, row: 'scheduled' | 'skills'): Promise<Locator> {
  if (isPhone(page)) return (await phoneTrinaHome(page)).getByTestId(`nav-${row}`)
  return (await showPanel(page, 'trina')).getByTestId(`nav-${row}`)
}

/** Show the AI's history (the 트리나 panel; the 트리나 tab's drawer). Then `navChatList`, `navChatRow`. */
export async function showChats(page: Page) {
  if (isPhone(page)) await phoneTrinaHome(page)
  else await showPanel(page, 'trina')
}

/** The AI's history list (`showChats` first): the Trina list, its filtered view while a filter is on, or a phone
 * drawer's history. Chat rows
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

/** The history's filter (status, last activity, group by, sort): the 트리나 panel's header button, the drawer's.
 * Opens its menu; its items are `recents-view-*` and `recents-<view>-<choice>`. */
export async function openChatFilter(page: Page) {
  await showChats(page)
  await (isPhone(page) ? phoneDrawer(page) : panel(page, 'trina')).getByTestId('recents-filter').first().click()
}

/** The filter's "reset" (shown while a filter is on). */
export const chatFilterClear = (page: Page) => page.getByTestId('recents-filter-clear')

/** The list panel on a computer (a navigation landmark named by its title), shown: for "it shows up in the list". */
export async function navLists(page: Page, place: Place = 'trina'): Promise<Locator> {
  return showPanel(page, place)
}

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
export const settingsDialog = (page: Page) => page.getByRole('dialog').filter({ has: page.getByTestId('settings-title') })

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
