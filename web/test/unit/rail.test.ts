// The new navigation's rail (lib/rail.ts; docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1):
// - every route of the signed-in app (App.tsx, the routes under <Layout />) has a decision here: one rail place or
//   none. A route added to App.tsx without one fails this test, so no page is left with nothing lit by mistake;
// - the places: 트리나 (Home, chats, projects, scheduled tasks, team skills, deleted history, connector consent, the
//   welcome steps), 대화 (rooms and threads, and Activity's 멘션·스레드), 파일, 활동; none for Admin, the Slack pages
//   and an unknown address;
// - what each place remembers for this browser tab, and where a press goes (the last page there, or its start when it
//   is the lit one).
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RAIL_ITEMS, RAIL_ROOT, railHere, railLinkState, railOf, railState, railTarget, rememberRail, useRailMemory, type RailItem } from '../../src/lib/rail'
import { navRailOn } from '../../src/lib/navRail'
import { clearLocalData } from '../../src/lib/localData'
import { installDom } from './dom-host'

beforeAll(() => installDom())
afterEach(() => useRailMemory.getState().reset())

/** The paths of the routes under <Layout /> in App.tsx (the signed-in app's pages). */
function layoutRoutes(): string[] {
  const src = readFileSync(join(import.meta.dir, '../../src/App.tsx'), 'utf8')
  const start = src.indexOf('<Route element={<Layout />}>')
  expect(start).toBeGreaterThan(0)
  const end = src.indexOf('</Route>', start)
  const block = src.slice(start, end)
  // every <Route …> in the block must be one this reads (a route written another way, or a nested one, fails here
  // instead of being skipped)
  expect(block.includes('</Route>')).toBe(false)
  const paths = [...block.matchAll(/<Route\s+(index|path="([^"]*)")/g)].map((m) => (m[1] === 'index' ? '' : m[2]!))
  // (the block starts with the <Layout /> route itself)
  expect(paths.length).toBe([...block.matchAll(/<Route\b/g)].length - 1)
  expect(paths.length).toBeGreaterThan(20)
  return paths
}

/** The decision for each route, as App.tsx writes it (without the leading "/"; "" is Home). */
const DECIDED: Record<string, RailItem | null> = {
  '': 'ai',
  'c/:chatId': 'ai',
  rooms: 'chats',
  'rooms/:roomId': 'chats',
  'rooms/:roomId/t/:messageId': 'chats',
  activity: 'activity',
  files: 'files',
  'files/view': 'files',
  projects: 'ai',
  'projects/:projectId': 'ai',
  'projects/:projectId/files': 'ai',
  admin: null,
  'admin/:section': null,
  'admin/:section/:sub': null,
  'admin/:section/:sub/:item': null,
  trash: 'ai',
  skills: 'ai',
  'skills/share/:id': 'ai',
  scheduled: 'ai',
  'scheduled/:id': 'ai',
  welcome: 'ai',
  'connectors/authorize': 'ai',
  'slack/link': null,
  'slack/signin-return': null,
  'slack/done': null,
  '*': null,
}
/** a concrete address for a route pattern */
const sample = (route: string) => '/' + route.replace(/:[A-Za-z]+/g, '01900000-0000-7000-8000-000000000001').replace('*', 'no-such-page')

describe('every route has a place or none', () => {
  test('each route under <Layout /> in App.tsx is decided here (add the new one to DECIDED and to lib/rail.ts)', () => {
    const routes = layoutRoutes()
    expect(routes.filter((r) => !(r in DECIDED))).toEqual([])
    // and nothing decided here is gone from App.tsx (a stale row would hide a renamed route)
    expect(Object.keys(DECIDED).filter((r) => !routes.includes(r))).toEqual([])
  })

  for (const [route, item] of Object.entries(DECIDED))
    test(`/${route} → ${item ?? 'none'}`, () => {
      expect(railOf(sample(route))).toBe(item)
    })
})

describe('the places', () => {
  test('four, in the order of the phone tabs: 트리나 · 대화 · 파일 · 활동', () => {
    expect(RAIL_ITEMS).toEqual(['ai', 'chats', 'files', 'activity'])
    for (const i of RAIL_ITEMS) expect(railOf(RAIL_ROOT[i])).toBe(i)
  })

  test("Activity's 멘션·스레드 is 대화's; the rest of Activity is 활동", () => {
    expect(railOf('/activity', '?in=chats')).toBe('chats')
    expect(railOf('/activity', '?in=chats&tab=threads')).toBe('chats')
    expect(railOf('/activity', '')).toBe('activity')
    expect(railOf('/activity', '?tab=all')).toBe('activity')
  })

  test('/new (the phone composer, a later phase) is 트리나; look-alike paths are not', () => {
    expect(railOf('/new')).toBe('ai')
    expect(railOf('/newsletter')).toBeNull()
    expect(railOf('/roomsx')).toBeNull()
    expect(railOf('/filesystem')).toBeNull()
    expect(railOf('/settings')).toBeNull()
  })

  test('as the router matches: any letter case and a trailing slash; an address only "not found" shows lights none', () => {
    expect(railOf('/Rooms')).toBe('chats')
    expect(railOf('/rooms/')).toBe('chats')
    expect(railOf('/FILES/view')).toBe('files')
    for (const p of ['/c', '/files/view/x', '/rooms/a/b/c/d', '/trash/x', '/activity/x']) expect(railOf(p)).toBeNull()
  })
})

describe('what each place remembers', () => {
  test('the last page per place; a press goes there, a press on the lit place goes to its start', () => {
    rememberRail('/c/abc')
    rememberRail('/rooms/r1', '')
    rememberRail('/activity', '?in=chats')
    rememberRail('/admin/members')
    const { last } = useRailMemory.getState()
    expect(last).toEqual({ ai: '/c/abc', chats: '/activity?in=chats' })
    expect(railTarget('ai', 'chats', last)).toBe('/c/abc')
    expect(railTarget('ai', 'ai', last)).toBe('/')
    expect(railTarget('files', 'ai', last)).toBe('/files')
  })

  test('a kept address is a path of this app (never //host)', () => {
    sessionStorage.setItem('mycel.rail.last', JSON.stringify({ ai: '//evil.example/x', chats: '/rooms/r1', files: 3, activity: 'https://x' }))
    // read again as a new page would
    return import(`../../src/lib/rail?again=${Date.now()}`).then((m: typeof import('../../src/lib/rail')) => {
      expect(m.useRailMemory.getState().last).toEqual({ chats: '/rooms/r1' })
    })
  })

  test('kept for this browser tab (sessionStorage) and dropped on sign-out (reset, and clearLocalData)', () => {
    rememberRail('/files', '?path=shared')
    expect(JSON.parse(sessionStorage.getItem('mycel.rail.last') ?? '{}')).toEqual({ files: '/files?path=shared' })
    useRailMemory.getState().reset()
    expect(useRailMemory.getState().last).toEqual({})
    expect(sessionStorage.getItem('mycel.rail.last')).toBe('{}')
    rememberRail('/files')
    clearLocalData()
    expect(sessionStorage.getItem('mycel.rail.last')).toBeNull()
  })
})

describe("a page opened from another place's list (phase P3: a notice's chat opened from 활동)", () => {
  test("the entry's state names the place lit; never on an address of no place", () => {
    expect(railState({ rail: 'activity' })).toBe('activity')
    expect(railState({ rail: 'nope' })).toBeNull()
    expect(railState(null)).toBeNull()
    expect(railHere('/c/abc', '', { rail: 'activity' })).toBe('activity')
    expect(railHere('/c/abc', '', null)).toBe('ai')
    expect(railHere('/admin/members', '', { rail: 'activity' })).toBeNull()
  })

  test('kept as what is open in 활동, and a press on 활동 opens it with 활동 lit again', () => {
    rememberRail('/c/abc', '', { rail: 'activity' })
    const { last } = useRailMemory.getState()
    expect(last).toEqual({ activity: '/c/abc' })
    expect(railTarget('activity', 'ai', last)).toBe('/c/abc')
    expect(railLinkState('activity', '/c/abc')).toEqual({ rail: 'activity' })
    expect(railLinkState('activity', '/activity?n=1')).toBeUndefined()
    expect(railLinkState('ai', '/c/abc')).toBeUndefined()
  })
})

describe('the switch', () => {
  test('on only when the server says so (Me.server.navRail)', () => {
    expect(navRailOn(null)).toBe(false)
    expect(navRailOn({ server: { version: '0', dev: false } } as never)).toBe(false)
    expect(navRailOn({ server: { version: '0', dev: false, navRail: true } } as never)).toBe(true)
  })
})
