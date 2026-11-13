// The phone's four tabs (below 768 px; components/BottomTabs.tsx) and where each address belongs (docs/DECISIONS.md
// "Phone tabs: 트리나 · 대화 · 파일 · 나"): 트리나 (the Trina list first: pinned, folders, projects, other chats, and every
// project behind 모든 프로젝트; a new chat is /new), 대화 (rooms, DMs and group chats), 파일 (the team folder's places:
// recent files, team and project folders, 내 파일, the trash) and 나 (Settings, with 활동 and the team's row). The app
// opens on START_TAB: one line to change. Old entries of the 프로젝트 tab (before the new navigation) take their first
// screen's tab (screenHistory.ts knownTab): a project → 트리나, the team folder → 파일.
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

/** The bar's tabs, in its order. */
export const PHONE_TABS = ['ai', 'chats', 'files', 'me'] as const
export type Tab = (typeof PHONE_TABS)[number]
/** Is this one of the bar's tabs (an entry kept from an older set of tabs, 프로젝트's, is not). */
export const isTabNow = (tab: string): tab is Tab => (PHONE_TABS as readonly string[]).includes(tab)

/** Where a phone opens (the sign-in landing and the app opened on `/`). 'chats' would open on the 대화 list. */
export const START_TAB: Tab = 'ai'

/** each tab's own list, where its ‹ falls back to and where the tab bar's button goes */
export const TAB_ROOT: Record<Tab, string> = { ai: '/', chats: '/rooms', files: '/files', me: '/settings' }

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

/** the AI tab's pages besides its list and the chats: the quiet rows at the end of the list (`/trash` is the deleted AI
 * chats; the team folder's Trash is `/files?view=trash`, 파일's), and an outside AI app's consent page */
const AI_PAGES = ['/scheduled', '/skills', '/trash', '/connectors/authorize']

export function tabOf(path: string): Tab | null {
  if (path === '/' || path.startsWith('/c/') || AI_PAGES.some((p) => under(path, p))) return 'ai'
  if (under(path, '/rooms')) return 'chats'
  // the new chat's own page (/new), and the projects: 트리나's list has them
  if (path === '/new' || under(path, '/projects')) return 'ai'
  if (under(path, '/files')) return 'files'
  // Connectors' old addresses open Settings › Connectors (App.tsx)
  if (under(path, '/settings') || under(path, '/admin') || under(path, '/activity') || under(path, '/connectors')) return 'me'
  return null
}

/** where the bar stays away: inside a room and inside an AI chat (their message box needs the bottom), on the
 * new-chat page (/new, the same box), and on Getting started (/welcome), a full-screen flow with its own
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

/** The AI's one name in the app's chrome (the tab, the rail, the phone's top bar): "트리나" where the product is named
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
