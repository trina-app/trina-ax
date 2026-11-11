// The phone's four tabs (below 768 px; components/BottomTabs.tsx) and where each address belongs: 트리나 (the AI: a new
// chat on Home, the AI's history behind ☰ there, and the pages that drawer opens), 대화 (rooms, DMs and group chats), 파일
// and 나 (Settings, with the Inbox and Admin). The app opens on START_TAB: one line to change. docs/DECISIONS.md
// "Phone navigation: four tabs".
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export type Tab = 'ai' | 'chats' | 'files' | 'me'

/** Where a phone opens (the sign-in landing and the app opened on `/`). 'chats' would open on the 대화 list. */
export const START_TAB: Tab = 'ai'

/** each tab's own list, where its ‹ falls back to and where the tab bar's button goes */
export const TAB_ROOT: Record<Tab, string> = { ai: '/', chats: '/rooms', files: '/files', me: '/settings' }

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

/** the AI tab's pages besides Home and the chats: what the ☰ drawer opens */
const AI_PAGES = ['/projects', '/scheduled', '/skills', '/connectors', '/trash']

export function tabOf(path: string): Tab | null {
  if (path === '/' || path.startsWith('/c/') || AI_PAGES.some((p) => under(path, p))) return 'ai'
  if (under(path, '/rooms')) return 'chats'
  if (under(path, '/files')) return 'files'
  if (under(path, '/settings') || under(path, '/admin')) return 'me'
  return null
}

/** where the bar stays away: inside a room and inside an AI chat (their message box needs the bottom) */
export const hidesTabs = (path: string) => /^\/rooms\/[^/]+/.test(path) || path.startsWith('/c/')

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
  ['/connectors', 'integrations.title'],
  ['/trash', 'trash.title'],
  ['/admin', 'admin.title'],
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
