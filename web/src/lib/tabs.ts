// The phone's four tabs (below 768 px; components/BottomTabs.tsx) and where each address belongs: 트리나 (the AI: a new
// chat on Home, the AI's history behind ☰ there, and the pages that drawer opens), 대화 (rooms, DMs and group chats),
// 프로젝트 (the projects, and the team folder: Files and its Trash, a row at the end of the projects list) and 나
// (Settings, with the Inbox and Admin). The app opens on START_TAB: one line to change. docs/DECISIONS.md "Phone
// navigation: four tabs"; 프로젝트 in place of 파일: QA TC-255 (the owner, 2026-11-12, option D).
// With the server's `navRail` switch on (lib/navRail.ts sets it here; docs/DECISIONS.md "Phone tabs: 트리나 · 대화 · 파일 ·
// 나"), the tabs are 트리나 (the Trina list first: pinned, folders, projects, other chats, and every project behind
// 모든 프로젝트; a new chat is /new), 대화, 파일 (the team folder's places: recent files, team and project folders, 내
// 파일, the trash) and 나 (Settings, with 활동 and the team's row). Old entries of the 프로젝트 tab take their first
// screen's tab (screenHistory.ts knownTab): a project → 트리나, the team folder → 파일.
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export type Tab = 'ai' | 'chats' | 'projects' | 'files' | 'me'

let v2 = false
/** The new navigation's phone tabs (트리나 · 대화 · 파일 · 나) are on: set by lib/navRail.ts from the server's switch. */
export const phoneTabsV2 = () => v2
export function setPhoneTabsV2(on: boolean) {
  v2 = on
}
/** The tabs of the bar on show, in its order. */
export const phoneTabs = (): readonly Tab[] => (v2 ? ['ai', 'chats', 'files', 'me'] : ['ai', 'chats', 'projects', 'me'])
/** Is this one of the bar's tabs now (an entry kept from the other set of tabs is not). */
export const isTabNow = (tab: string): tab is Tab => (phoneTabs() as readonly string[]).includes(tab)

/** Where a phone opens (the sign-in landing and the app opened on `/`). 'chats' would open on the 대화 list. */
export const START_TAB: Tab = 'ai'

/** each tab's own list, where its ‹ falls back to and where the tab bar's button goes */
export const TAB_ROOT: Record<Tab, string> = { ai: '/', chats: '/rooms', projects: '/projects', files: '/files', me: '/settings' }

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

/** the AI tab's pages besides Home and the chats: what the ☰ drawer opens (`/trash` is the deleted AI chats; the team
 * folder's Trash is `/files?view=trash`, 프로젝트's), and an outside AI app's consent page */
const AI_PAGES = ['/scheduled', '/skills', '/trash', '/connectors/authorize']

export function tabOf(path: string): Tab | null {
  if (path === '/' || path.startsWith('/c/') || AI_PAGES.some((p) => under(path, p))) return 'ai'
  if (under(path, '/rooms')) return 'chats'
  if (v2) {
    // the new chat's own page (/new), and the projects: 트리나's list has them
    if (path === '/new' || under(path, '/projects')) return 'ai'
    if (under(path, '/files')) return 'files'
  } else if (under(path, '/projects') || under(path, '/files')) return 'projects'
  // Connectors' old addresses open Settings › Connectors (App.tsx)
  if (under(path, '/settings') || under(path, '/admin') || under(path, '/activity') || under(path, '/connectors')) return 'me'
  return null
}

/** where the bar stays away: inside a room and inside an AI chat (their message box needs the bottom), on the new
 * navigation's new-chat page (/new, the same box), and on Getting started (/welcome), a full-screen flow with its own
 * bar (pages/Welcome.tsx: ‹ · the step · 나중에) */
export const hidesTabs = (path: string) => /^\/rooms\/[^/]+/.test(path) || path.startsWith('/c/') || path === '/new' || path === '/welcome'

/** A phone's landing address (START_TAB's list); a computer lands on Home. */
export function landingPath(phone: boolean): string {
  return phone ? TAB_ROOT[START_TAB] : '/'
}

/** The pages below a tab's list and the name the phone's top bar gives them (the page keeps its own heading for screen
 * readers only on a phone, so the name is not said twice). A detail page (one project, one task) is named after its
 * list: the bar says where it belongs, the page's own big heading says what it is. */
const PAGE_TITLE: [string, MessageKey][] = [
  ['/projects', 'projects.title'],
  ['/scheduled', 'settings.schedules'],
  ['/skills', 'skills.title'],
  ['/trash', 'trash.title'],
  ['/admin', 'admin.title'],
  ['/activity', 'inbox.title'],
]
export function pageTitleKey(path: string): MessageKey | null {
  return PAGE_TITLE.find(([p]) => under(path, p))?.[1] ?? null
}

/** The AI's one name in the app's chrome (the tab, the phone's top bar, the drawer): "트리나" where the product is named
 * after its AI (the Trina edition), else the product's own short name (the core edition). */
export function aiName(t: (key: MessageKey) => string): string {
  return PRODUCT_NAMED_AFTER_AI ? t('rooms.aiName') : PRODUCT.shortName
}

/** `{product}` for copy that sits beside the AI's name ("트리나에게 묻기"): the ready-made skills ("트리나가 준비한 스킬"),
 * who made them, and the invite message. Where the product is named after its AI the UI calls it by that name in each
 * language (as aiName), never by its full name in one place and the AI's in the next; else the product's own
 * name. */
export function namedProduct(t: (key: MessageKey) => string): { product: string } {
  return { product: PRODUCT_NAMED_AFTER_AI ? t('rooms.aiName') : PRODUCT.displayName }
}
