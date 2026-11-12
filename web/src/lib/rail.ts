// The new navigation's left rail on computers (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1; behind the server's
// `navRail` switch, lib/navRail.ts). Four places, in the order of the phone's tabs: 트리나 (the AI: Home, its chats,
// projects, scheduled tasks, team skills, deleted history), 대화 (rooms, DMs, group chats and their 멘션·스레드), 파일 and
// 활동. Every address of the app belongs to one place or to none (Admin, the Slack pages, an unknown address): the rail
// lights that place. Settings is a dialog over a page, so the caller asks with the page under it (App.tsx
// `settings.under`). Each place remembers what was open in it for this browser tab (sessionStorage): going back to 트리나
// opens the last AI chat again, back to 대화 the last room. Pure but for that small memory; every route of App.tsx is
// checked in test/unit/rail.test.ts. Started from the 11-13 draft (branch wip/rail-draft), changed to the plan's four
// places (no 프로젝트 place: projects are in 트리나's list).
import { matchPath } from 'react-router-dom'
import { create } from 'zustand'
import { RAIL_LAST_KEY } from './localData'
import { activityInChats } from './screens'

export type RailItem = 'ai' | 'chats' | 'files' | 'activity'
/** the rail's order, top to bottom: the phone's tabs 1–3, then 활동 (the phone has it under 나) */
export const RAIL_ITEMS: readonly RailItem[] = ['ai', 'chats', 'files', 'activity']

/** where a place starts (its first visit, or a press on the place already lit) */
export const RAIL_ROOT: Record<RailItem, string> = { ai: '/', chats: '/rooms', files: '/files', activity: '/activity' }

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
