// The left rail on computers (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1). Four places, in the order of the phone's tabs: 트리나 (the AI: Home, its chats,
// projects, scheduled tasks, team skills, deleted history), 대화 (rooms, DMs, group chats and their 멘션·스레드), 파일 and
// 활동. Every address of the app belongs to one place or to none (Admin, the Slack pages, an unknown address): the rail
// lights that place. Settings is a dialog over a page, so the caller asks with the page under it (App.tsx
// `settings.under`). Each place remembers what was open in it for this browser tab (sessionStorage): going back to 트리나
// opens the last AI chat again, back to 대화 the last room. Pure but for that small memory; every route of App.tsx is
// checked in test/unit/rail.test.ts. Started from the 11-13 draft (branch wip/rail-draft), changed to the plan's four
// places (no 프로젝트 place: projects are in 트리나's list).
import { matchPath, useLocation } from 'react-router-dom'
import { create } from 'zustand'
import { RAIL_LAST_KEY } from './localData'
import { activityInChats } from './screens'

export type RailItem = 'ai' | 'chats' | 'files' | 'activity'
/** the rail's order, top to bottom: the phone's tabs 1–3, then 활동 (the phone has it under 나) */
export const RAIL_ITEMS: readonly RailItem[] = ['ai', 'chats', 'files', 'activity']

/** where a place starts (its first visit, or a press on the place already lit): 파일's is its 최근 파일 */
export const RAIL_ROOT: Record<RailItem, string> = { ai: '/', chats: '/rooms', files: '/files?view=recent', activity: '/activity' }

/** The routes of App.tsx (under <Layout />) that belong to a place, as App.tsx writes them; any other address (Admin,
 * the Slack link pages, an address that only shows "not found") lights none. `/new` is the phone's composer of a later
 * phase. test/unit/rail.test.ts keeps this in step with App.tsx. */
const PAGES: Record<RailItem, readonly string[]> = {
  ai: ['/', '/new', '/c/:chatId', '/projects', '/projects/:projectId', '/projects/:projectId/files', '/scheduled', '/scheduled/:id', '/skills', '/skills/share/:id', '/trash', '/connectors/authorize', '/welcome'],
  chats: ['/rooms', '/rooms/:roomId', '/rooms/:roomId/t/:messageId'],
  files: ['/files', '/files/view'],
  activity: ['/activity'],
}

/**
 * The place an address belongs to, or null (Admin, the Slack link pages, an unknown address, Settings itself: no place
 * lit). Matched as the router matches (any letter case, a trailing slash). The conversations' part of Activity
 * (멘션·스레드, `?in=chats`) is 대화's, as on a phone.
 */
export function railOf(pathname: string, search = ''): RailItem | null {
  const item = RAIL_ITEMS.find((i) => PAGES[i].some((p) => matchPath(p, pathname)))
  if (item === 'activity' && activityInChats(search)) return 'chats'
  return item ?? null
}

const KEY = RAIL_LAST_KEY
/** a kept address: one of this app's (a path, never `//host`, which a link would take as another site) */
const ownPath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')
const read = (): Partial<Record<RailItem, string>> => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(RAIL_ITEMS.flatMap((i) => (ownPath(v[i]) ? [[i, v[i]]] : [])))
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
  if (named && item === named) kept = { path: pathname, item }
  else if (kept && kept.path === pathname && railOf(pathname, search)) return kept.item
  else kept = null
  return item
}

/** The place lit for the entry on screen (railHereKept with the router's location). */
export function useRailHere(): RailItem | null {
  const { pathname, search, state } = useLocation()
  return railHereKept(pathname, search, state)
}

/** The address on screen belongs to a place: kept as what is open there (`state`: the entry's, see railHere). */
export function rememberRail(pathname: string, search = '', state?: unknown) {
  const item = railHereKept(pathname, search, state)
  if (!item) return
  const to = `${pathname}${search}`
  const { last } = useRailMemory.getState()
  if (last[item] === to) return
  const next = { ...last, [item]: to }
  write(next)
  useRailMemory.setState({ last: next })
}

/** Where a press on a place goes: what was open there, or its start; the place already lit goes to its start, as a
 * phone's tab does. */
export function railTarget(item: RailItem, current: RailItem | null, last: Partial<Record<RailItem, string>>): string {
  if (item === current) return RAIL_ROOT[item]
  return last[item] ?? RAIL_ROOT[item]
}

/** The state a press on a place carries to its target: the place itself, when what was open there belongs to another
 * place's address (a notice's chat kept as what is open in 활동), so 활동 is what lights again. */
export function railLinkState(item: RailItem, to: string): { [RAIL_STATE_KEY]: RailItem } | undefined {
  const u = new URL(to, 'http://x')
  return railOf(u.pathname, u.search) === item ? undefined : { [RAIL_STATE_KEY]: item }
}
