// What each open window shows now (server/src/realtime/looking.ts; docs/decisions/20261116-ai-screen-and-shared-tools.md):
// kept in memory per person and window, with a time; gone on close, after a silence, and capped. The AI's looking_at
// tool reads it (tests/unit/b-looking-at-tool.test.ts).
import { describe, expect, test } from 'bun:test'
import { ClientFrame, LOOKING_SCREENS, type LookingFrame } from '@mycel/shared/api'
import { Looking, LOOKING_FRAMES_PER_MIN, LOOKING_PAST_MS, LOOKING_PER_WINDOW, LOOKING_SNAPSHOT_MS, LOOKING_SNAPSHOTS_MAX, LOOKING_TTL_MS } from '../../server/src/realtime/looking'

const id = (n: number) => `01890000-0000-7000-8000-${String(n).padStart(12, '0')}`
const room = (n: number, thread?: number): LookingFrame => ({ type: 'looking', screen: 'room', roomId: id(n), ...(thread ? { threadRootId: id(thread) } : {}) })
const file = (p: string): LookingFrame => ({ type: 'looking', screen: 'file', filePath: p })
const nothing: LookingFrame = { type: 'looking', screen: null }
function make() {
  let now = 1_000_000
  const l = new Looking(() => now)
  return { l, tick: (ms: number) => { now += ms } }
}

describe('the frame', () => {
  test('ids only: a title or text is not part of it; a bad id or an unknown screen is refused', () => {
    expect(ClientFrame.safeParse(room(1, 2)).success).toBe(true)
    expect(ClientFrame.safeParse({ type: 'looking', screen: 'shared_file', linkId: 'A'.repeat(22) }).success).toBe(true)
    expect(ClientFrame.safeParse(nothing).success).toBe(true)
    const kept = ClientFrame.parse({ ...room(1), title: 'Payroll', text: 'secret' }) as Record<string, unknown>
    expect(Object.keys(kept).sort()).toEqual(['roomId', 'screen', 'type'])
    expect(ClientFrame.safeParse({ type: 'looking', screen: 'room', roomId: 'not-an-id' }).success).toBe(false)
    expect(ClientFrame.safeParse({ type: 'looking', screen: 'payroll' }).success).toBe(false)
    expect(ClientFrame.safeParse({ type: 'looking', screen: 'file', filePath: 'x'.repeat(1025) }).success).toBe(false)
    expect(ClientFrame.safeParse({ type: 'looking', screen: 'shared_file', linkId: '../etc' }).success).toBe(false)
    expect(LOOKING_SCREENS).toContain('other')
  })
})

describe('a window\'s state', () => {
  test('set: the newest place first, the one before it kept with its time', () => {
    const { l, tick } = make()
    l.frame('u', 'w1', file('sales/quote.pdf'))
    tick(1000)
    l.frame('u', 'w1', room(1, 2))
    const w = l.window('u', 'w1')!
    expect(w.current).toBe(true)
    expect(w.items.map((x) => x.screen)).toEqual(['room', 'file'])
    expect(w.items[0]).toMatchObject({ roomId: id(1), threadRootId: id(2), at: 1_001_000 })
    expect(w.items[1]).toMatchObject({ filePath: 'sales/quote.pdf', at: 1_000_000 })
    expect(l.window('u', 'w2')).toBeNull()
    expect(l.window('someone-else', 'w1')).toBeNull()
  })

  test('the same place again (after a reconnect) keeps its first time; a place gone back to is listed once', () => {
    const { l, tick } = make()
    l.frame('u', 'w1', room(1))
    tick(5000)
    l.frame('u', 'w1', room(1))
    expect(l.window('u', 'w1')!.items).toHaveLength(1)
    expect(l.window('u', 'w1')!.items[0]!.at).toBe(1_000_000)
    l.frame('u', 'w1', room(2))
    l.frame('u', 'w1', room(1))
    expect(l.window('u', 'w1')!.items.map((x) => x.roomId)).toEqual([id(1), id(2)])
  })

  test('capped: a window keeps its newest places only', () => {
    const { l } = make()
    for (let i = 1; i <= LOOKING_PER_WINDOW + 4; i++) l.frame('u', 'w1', room(i))
    const w = l.window('u', 'w1')!
    expect(w.items).toHaveLength(LOOKING_PER_WINDOW)
    expect(w.items[0]!.roomId).toBe(id(LOOKING_PER_WINDOW + 4))
  })

  test('a confidential chat: the window tells nothing, what it showed before included', () => {
    const { l } = make()
    l.frame('u', 'w1', file('hr/payroll.xlsx'))
    l.frame('u', 'w1', room(1))
    l.frame('u', 'w1', nothing)
    expect(l.window('u', 'w1')).toBeNull()
    // and it tells again once it shows something else
    l.frame('u', 'w1', room(3))
    expect(l.window('u', 'w1')!.items.map((x) => x.roomId)).toEqual([id(3)])
  })

  test('closed: gone at once; the person\'s other windows stay', () => {
    const { l } = make()
    l.frame('u', 'w1', room(1))
    l.frame('u', 'w2', room(2))
    l.closed('u', 'w1')
    expect(l.window('u', 'w1')).toBeNull()
    expect(l.window('u', 'w2')).not.toBeNull()
    l.closed('u', 'w2')
    expect(l.size).toMatchObject({ people: 0, windows: 0 })
  })

  test('TTL: a window not heard from is dropped; a ping keeps an idle window without a new frame', () => {
    const { l, tick } = make()
    l.frame('u', 'idle', room(1))
    l.frame('u', 'dead', room(2))
    for (let t = 0; t < LOOKING_TTL_MS * 3; t += 20_000) { tick(20_000); l.heard('u', 'idle') }
    expect(l.window('u', 'idle')!.items[0]!.roomId).toBe(id(1))
    expect(l.window('u', 'dead')).toBeNull()
    l.sweep()
    expect(l.size.windows).toBe(1)
    // heard() never makes state for a window that told nothing
    l.heard('u', 'never')
    expect(l.size.windows).toBe(1)
  })

  test('a place left long ago is no longer "just before"; the place shown now stays', () => {
    const { l, tick } = make()
    l.frame('u', 'w1', file('a.txt'))
    l.frame('u', 'w1', room(1))
    for (let t = 0; t <= LOOKING_PAST_MS; t += 60_000) { tick(60_000); l.heard('u', 'w1') }
    expect(l.window('u', 'w1')!.items.map((x) => x.screen)).toEqual(['room'])
  })

  test('the person\'s sessions ended: everything of theirs goes, snapshots too', () => {
    const { l } = make()
    l.frame('u', 'w1', room(1))
    l.snapshot('t1', 'u', 'w1')
    l.frame('v', 'w9', room(2))
    l.ended('u')
    expect(l.window('u', 'w1')).toBeNull()
    expect(l.snapshotOf('t1', 'u')).toBeUndefined()
    expect(l.window('v', 'w9')).not.toBeNull()
  })

  test('rate limit: frames past the minute\'s budget are ignored', () => {
    const { l, tick } = make()
    for (let i = 1; i <= LOOKING_FRAMES_PER_MIN; i++) l.frame('u', 'w1', room(i))
    l.frame('u', 'w1', room(9999))
    expect(l.window('u', 'w1')!.items[0]!.roomId).toBe(id(LOOKING_FRAMES_PER_MIN))
    tick(60_000)
    l.frame('u', 'w1', room(9999))
    expect(l.window('u', 'w1')!.items[0]!.roomId).toBe(id(9999))
  })

  test('other windows: the most recently changed first, never the asked one', () => {
    const { l, tick } = make()
    l.frame('u', 'w1', room(1)); tick(10)
    l.frame('u', 'w2', room(2)); tick(10)
    l.frame('u', 'w3', room(3))
    expect(l.others('u', 'w1').map((w) => w.windowId)).toEqual(['w3', 'w2'])
    expect(l.others('u', null).map((w) => w.windowId)).toEqual(['w3', 'w2', 'w1'])
  })
})

describe('a turn\'s snapshot', () => {
  test('what the window showed when the message was sent, not where the person went after', () => {
    const { l } = make()
    l.frame('u', 'w1', room(1, 5))
    l.snapshot('t1', 'u', 'w1')
    l.frame('u', 'w1', room(2))
    expect(l.snapshotOf('t1', 'u')!.items[0]).toMatchObject({ roomId: id(1), threadRootId: id(5) })
    // another person never reads it
    expect(l.snapshotOf('t1', 'v')).toBeUndefined()
    // a window that told nothing: null (known to be nothing), no snapshot at all: undefined
    l.snapshot('t2', 'u', 'w-none')
    expect(l.snapshotOf('t2', 'u')).toBeNull()
    expect(l.snapshotOf('t3', 'u')).toBeUndefined()
    l.forgetTurn('t1')
    expect(l.snapshotOf('t1', 'u')).toBeUndefined()
  })

  test('kept for a while and capped', () => {
    const { l, tick } = make()
    l.frame('u', 'w1', room(1))
    l.snapshot('old', 'u', 'w1')
    tick(LOOKING_SNAPSHOT_MS)
    expect(l.snapshotOf('old', 'u')).toBeUndefined()
    for (let i = 0; i < LOOKING_SNAPSHOTS_MAX + 10; i++) l.snapshot(`t${i}`, 'u', 'w1')
    expect(l.size.turns).toBe(LOOKING_SNAPSHOTS_MAX)
    l.sweep()
    expect(l.snapshotOf('old', 'u')).toBeUndefined()
  })
})
