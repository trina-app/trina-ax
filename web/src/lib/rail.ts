// The left rail on computers (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1). Four places, in the order of the phone's tabs: 트리나 (the AI: Home, its chats,
// projects, scheduled tasks, team skills, deleted history), 대화 (rooms, DMs and group chats), 파일 and
// 활동. Every address of the app belongs to one place or to none (Admin, the Slack pages, an unknown address): the rail
// lights that place. Settings is a dialog over a page, so the caller asks with the page under it (App.tsx
// `settings.under`). Each place remembers what was open in it for this browser tab (sessionStorage): going back to 트리나
// opens the last AI chat again, back to 대화 the last room. Pure but for that small memory; every route of App.tsx is
// checked in test/unit/rail.test.ts. Projects were in 트리나's list until the owner's 11-13 review ("프로젝트가 어디까지인지
//안 보여"): now their own place, as on the phone.
import { matchPath, useLocation } from 'react-router-dom'
import { create } from 'zustand'
import { RAIL_LAST_KEY } from './localData'
import { oldChatsActivity } from './screens'

export type RailItem = 'ai' | 'chats' | 'projects' | 'files' | 'activity'
/** the rail's order, top to bottom: the phone's tabs 1–4, then 활동 (the phone has it under 나) */
export const RAIL_ITEMS: readonly RailItem[] = ['ai', 'chats', 'projects', 'files', 'activity']

/** where a place starts (its first visit, or a press on the place already lit). 파일's is the person's own folder, 내 파일
 * (docs/decisions/20261125-upload-destination.md, like Drive's My Drive: upload there first, share later); this
 * table's 최근 파일 is only the start while who is signed in is not known yet (railRoot) */
export const RAIL_ROOT: Record<RailItem, string> = { ai: '/', chats: '/rooms', projects: '/projects', files: '/files?view=recent', activity: '/activity' }
/** A place's start for this person: 파일 opens their own folder. */
export const railRoot = (item: RailItem, me?: string | null): string => (item === 'files' && me ? myFilesPath(me) : RAIL_ROOT[item])
/** The address of a person's own folder, 내 파일. */
export const myFilesPath = (me: string): string => `/files?path=${encodeURIComponent(`users/${me}`)}`

/** The routes of App.tsx (under <Layout />) that belong to a place, as App.tsx writes them; any other address (Admin,
 * the Slack link pages, an address that only shows "not found") lights none. `/new` is the phone's composer of a later
 * phase. test/unit/rail.test.ts keeps this in step with App.tsx. */
const PAGES: Record<RailItem, readonly string[]> = {
  ai: ['/', '/new', '/c/:chatId', '/c/:chatId/t/:messageId', '/c/:chatId/m/:target', '/scheduled', '/scheduled/:id', '/skills', '/skills/share/:id', '/trash', '/connectors/authorize', '/browser-ask/:id', '/welcome'],
  // (…/m/<message>: a phone notification's tap at one message, which goes on to ?m=<message>)
  chats: ['/rooms', '/rooms/:roomId', '/rooms/:roomId/t/:messageId', '/rooms/:roomId/m/:target', '/rooms/:roomId/t/:messageId/m/:target', '/sent-files'],
  projects: ['/projects', '/projects/:projectId', '/projects/:projectId/files'],
  // a file's link page (/f/<id>, QA TC-3093) is the file's: Files is lit
  files: ['/files', '/files/view', '/f/:id', '/f/batch/:id'],
  // one notice by its id (/activity/<id>, a phone notification's tap) goes on to /activity?n=<id>
  activity: ['/activity', '/activity/:noticeId'],
}

/**
 * The place an address belongs to, or null (Admin, the Slack link pages, an unknown address, Settings itself: no place
 * lit). Matched as the router matches (any letter case, a trailing slash). Activity is one place with every notice
 * (docs/decisions/20261126-one-activity.md), whatever its search.
 */
// (`search` stays in the signature: the callers pass the address whole)
export function railOf(pathname: string, _search = ''): RailItem | null {
  const item = RAIL_ITEMS.find((i) => PAGES[i].some((p) => matchPath(p, pathname)))
  return item ?? null
}

const KEY = RAIL_LAST_KEY
/** a kept address: one of this app's (a path, never `//host`, which a link would take as another site) */
const ownPath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')
const read = (): Partial<Record<RailItem, string>> => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    // (an old 멘션·스레드 address kept under 대화 is no longer 대화's: dropped)
    return Object.fromEntries(RAIL_ITEMS.flatMap((i) => (ownPath(v[i]) && !(i === 'chats' && oldChatsActivity(v[i])) ? [[i, v[i]]] : [])))
  } catch {
    return {}
  }
}
const write = (last: Partial<Record<RailItem, string>>) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(last))
  } catch {
    /* not kept: a private window may refuse */
  }
}

/** What was open in each place, this browser tab (dropped when the person signs out: App.tsx dropPersonStores). */
export const useRailMemory = create<{ last: Partial<Record<RailItem, string>>; reset: () => void }>((set) => ({
  last: typeof window === 'undefined' ? {} : read(),
  reset: () => {
    write({})
    set({ last: {} })
  },
}))

/** The history entry's own place, when a page was opened from a place's list for another place's page: 활동's list opens
 * a notice's chat, project or scheduled task on the right while 활동 stays lit. Kept in the entry's state
 * (`{ rail: 'activity' }`), so Back and Forward keep it; a link followed inside that page lights the page's own place. */
export const RAIL_STATE_KEY = 'rail'
export function railState(state: unknown): RailItem | null {
  const v = state && typeof state === 'object' ? (state as Record<string, unknown>)[RAIL_STATE_KEY] : null
  return typeof v === 'string' && (RAIL_ITEMS as readonly string[]).includes(v) ? (v as RailItem) : null
}

/** The place lit for an entry: the place its state names (an address that belongs to a place: never Admin or an unknown
 * address), else the address's own (railOf). */
export function railHere(pathname: string, search = '', state?: unknown): RailItem | null {
  const own = railOf(pathname, search)
  return own ? railState(state) ?? own : null
}

/** The place an entry's state named stays while the page tidies its own address in place (a closed dialog drops ?new=1
 * with a replace that carries no state): the same path keeps it; another path lights its own place. */
let kept: { path: string; item: RailItem } | null = null
export function railHereKept(pathname: string, search = '', state?: unknown): RailItem | null {
  const named = railState(state)
  const item = railHere(pathname, search, state)
  // (only a place other than the address's own needs keeping: a rail press names its own place on every entry)
  if (named && item === named) kept = item !== railOf(pathname, search) ? { path: pathname, item } : null
  else if (kept && kept.path === pathname && railOf(pathname, search)) return kept.item
  else kept = null
  return item
}

/** The place lit for the entry on screen (railHereKept with the router's location). */
export function useRailHere(): RailItem | null {
  const { pathname, search, state } = useLocation()
  return railHereKept(pathname, search, state)
}

/** Pages a place lights but never reopens: the owner's setup steps (/welcome) are reached from their setup row, so 트리나
 * opens the Trina list, not the wizard again (UX review S3). */
const NOT_KEPT = ['/welcome']

/** The address on screen belongs to a place: kept as what is open there (`state`: the entry's, see railHere). */
export function rememberRail(pathname: string, search = '', state?: unknown) {
  const item = railHereKept(pathname, search, state)
  if (!item || NOT_KEPT.some((p) => matchPath(p, pathname))) return
  const to = `${pathname}${search}`
  const { last } = useRailMemory.getState()
  if (last[item] === to) return
  const next = { ...last, [item]: to }
  write(next)
  useRailMemory.setState({ last: next })
}

/** Where a press on a place goes: what was open there, or its start; the place already lit goes to its start, as a
 * phone's tab does. */
export function railTarget(item: RailItem, current: RailItem | null, last: Partial<Record<RailItem, string>>, me?: string | null): string {
  if (item === current) return railRoot(item, me)
  return last[item] ?? railRoot(item, me)
}

/** The state a press on a place carries to its target: always the place itself. A notice's chat kept as what is open in
 * 활동 then lights 활동 again; and a press on 트리나 whose last chat is the one 활동 opened (the same address, which the
 * router turns into a replace) lights 트리나, where an entry with no state would keep 활동 lit as a page tidying its own
 * address (railHereKept; the owner, 11-22: 트리나 could not be pressed). */
export function railLinkState(item: RailItem): { [RAIL_STATE_KEY]: RailItem } {
  return { [RAIL_STATE_KEY]: item }
}
