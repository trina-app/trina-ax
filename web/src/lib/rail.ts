// The new navigation's left rail on computers (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1; behind the server's
// `navRail` switch, lib/navRail.ts). Four places, in the order of the phone's tabs: 트리나 (the AI: Home, its chats,
// projects, scheduled tasks, team skills, deleted history), 대화 (rooms, DMs, group chats and their 멘션·스레드), 파일 and
// 활동. Every address of the app belongs to one place or to none (Admin, the Slack pages, an unknown address): the rail
// lights that place. Settings is a dialog over a page, so the caller asks with the page under it (App.tsx
// `settings.under`). Each place remembers what was open in it for this browser tab (sessionStorage): going back to 트리나
// opens the last AI chat again, back to 대화 the last room. Pure but for that small memory; every route of App.tsx is
// checked in test/unit/rail.test.ts. Started from the 11-13 draft (branch wip/rail-draft), changed to the plan's four
// places (no 프로젝트 place: projects are in 트리나's list).
import { create } from 'zustand'
import { activityInChats } from './screens'

export type RailItem = 'ai' | 'chats' | 'files' | 'activity'
/** the rail's order, top to bottom: the phone's tabs 1–3, then 활동 (the phone has it under 나) */
export const RAIL_ITEMS: readonly RailItem[] = ['ai', 'chats', 'files', 'activity']

/** where a place starts (its first visit, or a press on the place already lit) */
export const RAIL_ROOT: Record<RailItem, string> = { ai: '/', chats: '/rooms', files: '/files', activity: '/activity' }

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

/** the AI's pages: Home and its chats, and the pages its list opens */
const AI_PAGES = ['/new', '/c', '/projects', '/scheduled', '/skills', '/trash', '/connectors/authorize', '/welcome']

/**
 * The place an address belongs to, or null (Admin, the Slack link pages, an unknown address, Settings itself: no place
 * lit). The conversations' part of Activity (멘션·스레드, `?in=chats`) is 대화's, as on a phone.
 */
export function railOf(pathname: string, search = ''): RailItem | null {
  if (pathname === '/' || AI_PAGES.some((p) => under(pathname, p))) return 'ai'
  if (under(pathname, '/rooms')) return 'chats'
  if (under(pathname, '/activity')) return activityInChats(search) ? 'chats' : 'activity'
  if (under(pathname, '/files')) return 'files'
  return null
}

const KEY = 'mycel.rail.last'
const read = (): Partial<Record<RailItem, string>> => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(RAIL_ITEMS.flatMap((i) => (typeof v[i] === 'string' && (v[i] as string).startsWith('/') ? [[i, v[i]]] : [])))
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

/** The address on screen belongs to a place: kept as what is open there. */
export function rememberRail(pathname: string, search = '') {
  const item = railOf(pathname, search)
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
