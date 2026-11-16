// What this window tells the server it shows (lib/lookingAt.ts; docs/decisions/20261116-ai-screen-and-shared-tools.md):
// the frame for an address and the side panel (ids only, nothing for a confidential chat), and when it is sent (on a
// change, rate-limited, once more after a reconnect, never while nothing changes).
import { describe, expect, test } from 'bun:test'
import { ClientFrame, LOOKING_EVERY_MS, type LookingFrame } from '@mycel/shared/api'
import { LookingSender, lookingOf, NOTHING, type Looking } from '../../src/lib/lookingAt'
import type { SidePanel } from '../../src/lib/sidePanel'

const id = (n: number) => `01890000-0000-7000-8000-${String(n).padStart(12, '0')}`
const LINK = 'Ab3_-'.repeat(4) + 'xy'
const teamFile = (path: string): SidePanel => ({ kind: 'file', key: 1, file: { source: 'team', path, name: path.split('/').pop()! } })

describe('lookingOf: the address and the panel as ids', () => {
  const cases: [string, string, Looking][] = [
    ['/', '', { screen: 'home' }],
    ['/', '?project=p-1&prompt=secret%20words', { screen: 'home', projectId: 'p-1' }],
    [`/c/${id(1)}`, '', { screen: 'chat', chatId: id(1) }],
    [`/c/${id(1)}/t/${id(2)}`, '', { screen: 'chat', chatId: id(1) }],
    ['/rooms', '', { screen: 'rooms' }],
    [`/rooms/${id(3)}`, '', { screen: 'room', roomId: id(3) }],
    [`/rooms/${id(3)}/t/${id(4)}`, '', { screen: 'room', roomId: id(3), threadRootId: id(4) }],
    ['/files', '?path=marketing', { screen: 'files' }],
    ['/files', '?view=shared', { screen: 'shared_files' }],
    ['/files/view', '?path=sales%2FQuote%20v2.pdf', { screen: 'file', filePath: 'sales/Quote v2.pdf' }],
    [`/f/${LINK}`, '', { screen: 'shared_file', linkId: LINK }],
    ['/f/batch/abc', '', { screen: 'shared_files' }],
    ['/projects', '', { screen: 'projects' }],
    ['/projects/p-9/files', '', { screen: 'project', projectId: 'p-9' }],
    ['/activity', '', { screen: 'activity' }],
    ['/skills/share/x', '', { screen: 'skills' }],
    ['/scheduled/abc', '', { screen: 'scheduled' }],
    ['/admin/people', '', { screen: 'admin' }],
    ['/settings/security/devices', '', { screen: 'settings' }],
    ['/welcome', '', { screen: 'other' }],
  ]
  for (const [path, search, want] of cases) {
    test(`${path}${search}`, () => {
      const got = lookingOf(path, search, null)
      expect(got).toEqual(want)
      // every frame is one the server reads
      expect(ClientFrame.safeParse({ type: 'looking', ...got }).success).toBe(true)
    })
  }

  test('an id of the wrong shape is left out, never sent as it is', () => {
    expect(lookingOf('/c/not-an-id', '', null)).toEqual({ screen: 'chat' })
    expect(lookingOf('/rooms/abc/t/def', '', null)).toEqual({ screen: 'room' })
    expect(lookingOf(`/rooms/${id(1)}/t/def`, '', null)).toEqual({ screen: 'room', roomId: id(1) })
    expect(lookingOf('/f/short', '', null)).toEqual({ screen: 'shared_file' })
    expect(lookingOf('/files/view', `?path=${'x'.repeat(1100)}`, null)).toEqual({ screen: 'file' })
    expect(lookingOf('/c/%E0%A4%A', '', null)).toEqual({ screen: 'chat' })
  })

  test('a team file in the side panel is told with the page; a room\'s file, a local file, an artifact or the browser pane are not', () => {
    expect(lookingOf(`/c/${id(1)}`, '', teamFile('sales/Quote.pdf'))).toEqual({ screen: 'chat', chatId: id(1), filePath: 'sales/Quote.pdf' })
    expect(lookingOf(`/rooms/${id(3)}`, '', { kind: 'file', key: 1, file: { source: 'room', roomId: id(3), fileId: 'f1', name: 'a.pdf' } })).toEqual({ screen: 'room', roomId: id(3) })
    expect(lookingOf('/', '', { kind: 'artifact', chatId: id(1), artifactKey: 'k' })).toEqual({ screen: 'home' })
    expect(lookingOf('/', '', { kind: 'browser' })).toEqual({ screen: 'home' })
    // the page's own file wins over the panel's
    expect(lookingOf('/files/view', '?path=a.md', teamFile('b.md'))).toEqual({ screen: 'file', filePath: 'a.md' })
  })

  test('only ids: no title, name or text is ever in the frame', () => {
    const got = lookingOf(`/rooms/${id(3)}/t/${id(4)}`, '?q=secret', teamFile('hr/Payroll 2026.xlsx'))
    expect(Object.keys(got).sort()).toEqual(['filePath', 'roomId', 'screen', 'threadRootId'])
    expect(JSON.stringify(got)).not.toContain('secret')
  })

  test('a confidential chat on the screen: nothing, the panel\'s file included', () => {
    expect(lookingOf(`/c/${id(1)}`, '', teamFile('sales/Quote.pdf'), true)).toEqual(NOTHING)
    expect(ClientFrame.safeParse({ type: 'looking', ...NOTHING }).success).toBe(true)
  })
})

function clock() {
  let now = 10_000
  const timers: { at: number; fn: () => void }[] = []
  return {
    t: { now: () => now, setTimeout: (fn: () => void, ms: number) => { const x = { at: now + ms, fn }; timers.push(x); return x }, clearTimeout: (x: unknown) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1) } },
    tick(ms: number) { now += ms; for (const x of [...timers].sort((a, b) => a.at - b.at)) if (x.at <= now) { timers.splice(timers.indexOf(x), 1); x.fn() } },
    pending: () => timers.length,
  }
}

describe('LookingSender: when a frame goes', () => {
  test('one frame per change; the same screen again sends nothing; an idle window has no timer', () => {
    const c = clock()
    const sent: LookingFrame[] = []
    const s = new LookingSender((f) => { sent.push(f) }, c.t)
    s.report({ screen: 'rooms' })
    expect(sent).toEqual([{ type: 'looking', screen: 'rooms' }])
    s.report({ screen: 'rooms' })
    c.tick(60_000)
    expect(sent).toHaveLength(1)
    expect(c.pending()).toBe(0)
  })

  test('rate limit: quick changes become one frame with the last state', () => {
    const c = clock()
    const sent: LookingFrame[] = []
    const s = new LookingSender((f) => { sent.push(f) }, c.t)
    s.report({ screen: 'rooms' })
    s.report({ screen: 'room', roomId: id(1) })
    s.report({ screen: 'room', roomId: id(2) })
    s.report({ screen: 'room', roomId: id(3) })
    expect(sent).toHaveLength(1)
    expect(c.pending()).toBe(1)
    c.tick(LOOKING_EVERY_MS)
    expect(sent.map((f) => f.roomId)).toEqual([undefined, id(3)])
    expect(c.pending()).toBe(0)
    // back to the first screen inside the wait: nothing more to send than the state it ends on
    s.report({ screen: 'files' })
    s.report({ screen: 'room', roomId: id(3) })
    c.tick(LOOKING_EVERY_MS)
    expect(sent).toHaveLength(2)
  })

  test('after a reconnect the current state goes once more; while disconnected nothing is queued', () => {
    const c = clock()
    const sent: LookingFrame[] = []
    let open = true
    const s = new LookingSender((f) => { if (!open) return false; sent.push(f); return true }, c.t)
    s.report({ screen: 'room', roomId: id(1) })
    open = false
    c.tick(5000)
    s.report({ screen: 'room', roomId: id(2) })
    s.report({ screen: 'files' })
    expect(sent).toHaveLength(1)
    open = true
    s.connected()
    expect(sent.at(-1)).toEqual({ type: 'looking', screen: 'files' })
    expect(sent).toHaveLength(2)
    // a reconnect with nothing changed: the same state again (the server forgot the window with its socket)
    c.tick(5000)
    s.connected()
    expect(sent).toHaveLength(3)
  })

  test('reset: nothing is kept', () => {
    const c = clock()
    const sent: LookingFrame[] = []
    const s = new LookingSender((f) => { sent.push(f) }, c.t)
    s.report({ screen: 'rooms' })
    s.report({ screen: 'files' })
    s.reset()
    c.tick(60_000)
    s.connected()
    expect(sent).toHaveLength(1)
    expect(c.pending()).toBe(0)
  })
})
