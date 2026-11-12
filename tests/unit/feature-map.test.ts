// The feature map (docs/FEATURES.md): the check, the units read from the code and the gap status of the Features tab.
import { describe, expect, test } from 'bun:test'
import { FEATURES, type Feature } from '../../docs/features'
import { buildMap } from '../../scripts/features/map'
import { featureRows, parseFeatureCell, summaryLine, type QaRow } from '../../scripts/features/status'
import { col } from '../../scripts/features/sync-sheet'
import { globRe, readEndpoints, readScreens, routesIn, screenOfUrl, type EndpointUnit } from '../../scripts/features/units'

const ep = (name: string, group = 'ROOMS'): EndpointUnit => ({ name, group, method: 'GET', path: `/api/${name}`, auth: 'user', summary: '' })

describe('features:check', () => {
  test('the real map has no problems: every endpoint and screen belongs to a feature', () => {
    const map = buildMap(FEATURES, readEndpoints(), readScreens())
    expect(map.problems).toEqual([])
    expect(Object.keys(map.endpoints).length).toBeGreaterThan(300)
    expect(Object.keys(map.screens)).toContain('/rooms/:roomId/t/:messageId')
  })

  test('an endpoint or a screen of no feature is named, with where to add it', () => {
    const map = buildMap([{ id: 'rooms.list', name: 'Rooms', area: 'Rooms', endpoints: ['listRooms'] }], [ep('listRooms'), ep('pinRoom')], [{ path: '/rooms', source: 'App.tsx' }])
    expect(map.problems).toEqual([
      'endpoint pinRoom (GET /api/pinRoom, ROOMS) belongs to no feature: add it to a feature in docs/features.ts',
      'screen /rooms (App.tsx) belongs to no feature: add it to a feature in docs/features.ts',
    ])
  })

  test('a pattern that matches nothing, a duplicate or badly formed id, and a manual feature with units fail', () => {
    const f: Feature[] = [
      { id: 'rooms.list', name: 'a', area: 'Rooms', endpoints: ['listRooms', 'gone*'] },
      { id: 'rooms.list', name: 'b', area: 'Rooms', manual: true, screens: ['/rooms'] },
      { id: 'Rooms', name: 'c', area: 'Rooms', screens: ['/rooms'] },
    ]
    const p = buildMap(f, [ep('listRooms')], [{ path: '/rooms', source: 'App.tsx' }]).problems
    expect(p.some((x) => x.includes('"gone*" matches nothing'))).toBe(true)
    expect(p.some((x) => x.includes('"rooms.list" is used twice'))).toBe(true)
    expect(p.some((x) => x.includes('"Rooms" is not'))).toBe(true)
    expect(p.some((x) => x.includes('manual but claims'))).toBe(true)
  })

  test('globs: * is any run, the rest is literal', () => {
    expect(globRe('*Room*').test('pinRoom')).toBe(true)
    expect(globRe('*Room*').test('listRooms')).toBe(true)
    expect(globRe('pin*').test('unpinRoom')).toBe(false)
    expect(globRe('/admin/system/*').test('/admin/system/backups')).toBe(true)
    expect(globRe('a.b').test('axb')).toBe(false)
  })
})

describe('units', () => {
  test('routes: paths and their element; redirects are left out of screens', () => {
    const r = routesIn('<Route index element={<Home />} />\n<Route path="rooms/:roomId" element={<RoomPage />} />\n<Route path="/x" element={<Navigate to="/" />} />')
    expect(r).toEqual([{ path: '', element: 'Home' }, { path: 'rooms/:roomId', element: 'RoomPage' }, { path: '/x', element: 'Navigate' }])
    const screens = readScreens().map((s) => s.path)
    expect(screens).toContain('/')
    expect(screens).toContain('/settings/profile')
    expect(screens).toContain('/admin/members')
    expect(screens).not.toContain('/settings/schedules')
    expect(screens).not.toContain('/admin/:section')
  })

  test('an address belongs to the most written-out screen', () => {
    const s = ['/rooms', '/rooms/:roomId', '/rooms/:roomId/t/:messageId', '/settings/connectors/:id', '/settings/connectors/mcp/:integrationId']
    expect(screenOfUrl('http://127.0.0.1:1/rooms/r1/t/m2?x=1', s)).toBe('/rooms/:roomId/t/:messageId')
    expect(screenOfUrl('/rooms/', s)).toBe('/rooms')
    expect(screenOfUrl('/settings/connectors/mcp/i1', s)).toBe('/settings/connectors/mcp/:integrationId')
    expect(screenOfUrl('/nowhere', s)).toBeNull()
  })
})

describe('gap status', () => {
  const map = {
    features: [
      { id: 'a.untested', name: '', area: 'Rooms' as const, endpoints: ['e1', 'e2'], screens: [] },
      { id: 'a.stale', name: '', area: 'Rooms' as const, endpoints: ['e3'], screens: [] },
      { id: 'a.partly', name: '', area: 'Rooms' as const, endpoints: ['e4', 'e5', 'e6'], screens: [] },
      { id: 'a.green', name: '', area: 'Rooms' as const, endpoints: ['e7'], screens: [] },
      { id: 'a.manual', name: '', area: 'Apps & hosting' as const, manual: true as const, endpoints: [], screens: [] },
    ],
  }
  const qa: QaRow[] = [
    { id: 'TC-1', result: 'Pass', testDate: '2026-11-01', features: ['a.stale'] },
    { id: 'TC-2', result: 'Pass', testDate: '2026-11-10', features: ['a.partly', 'a.green'] },
    { id: 'TC-3', result: 'Not run', testDate: '', features: ['a.untested'] },
    { id: 'TC-4', result: 'Fail', testDate: '2026-11-11', features: ['a.manual'] },
  ]
  const changed: Record<string, string> = { 'a.stale': '2026-11-05', 'a.green': '2026-11-09' }
  const rows = featureRows(map, { e3: 2, e4: 1, e7: 5 }, qa, (id) => changed[id] ?? '')
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))

  test('Untested, Stale, Partly, Green and their order', () => {
    expect(rows.map((r) => [r.id, r.status])).toEqual([['a.manual', 'Untested'], ['a.untested', 'Untested'], ['a.stale', 'Stale'], ['a.partly', 'Partly'], ['a.green', 'Green']])
    expect(by['a.partly']!.e2ePct).toBe(33)
    expect(by['a.manual']!.e2ePct).toBeNull()
    expect(by['a.manual']!.qaFail).toBe(1)
    expect(by['a.untested']!.qaOpen).toBe(1)
    expect(by['a.green']!.lastPass).toBe('2026-11-10')
  })

  test('the summary line', () => {
    expect(summaryLine(rows, { e3: 2, e4: 1, e7: 5 }, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'])).toBe('5 features · 1 green · 1 stale · 1 partly · 2 untested · e2e reaches 3 of 8 endpoints (38%)')
  })

  test('a QA cell may name several features; sheet columns', () => {
    expect(parseFeatureCell(' rooms.ai, rooms.threads ')).toEqual(['rooms.ai', 'rooms.threads'])
    expect(parseFeatureCell('')).toEqual([])
    expect([col(0), col(15), col(25), col(26)]).toEqual(['A', 'P', 'Z', 'AA'])
  })
})
