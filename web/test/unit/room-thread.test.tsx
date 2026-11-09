// The thread panel (components/rooms/ThreadPanel.tsx; docs/DECISIONS.md "스레드와 반응"): the root on top, how many
// replies, the replies, and a reply box whose one extra choice sends the reply to the room too; a thread I cannot see
// says so without a box.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ThreadPanel } from '../../src/components/rooms/ThreadPanel'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { at, BEN, CY, ME, message, room } from './rooms-fixtures'
import { MOBILE_CAPABILITIES } from '../../../mobile/src/protocol'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let calls: { method: string; path: string; body: unknown }[] = []
let routes: Record<string, { status?: number; body: unknown }> = {}
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

function serve() {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const r = routes[`${method} ${path}`]
    if (!r) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

test('the root, how many replies, the replies; a reply sent with "also to the room" goes as one', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  const r = room()
  const root = message({ roomId: r.id, seq: 1, author: BEN, body: 'THE ROOT', thread: { replyCount: 2, lastReplyAt: at(3), repliers: [CY, BEN], newReplies: false } })
  const replies = [message({ roomId: r.id, seq: 2, author: CY, body: 'first reply', threadRootId: root.id }), message({ roomId: r.id, seq: 3, author: BEN, body: 'second reply', threadRootId: root.id })]
  routes = {
    [`GET /api/rooms/${r.id}/messages/${root.id}/thread`]: { body: { root, items: replies, nextCursor: null } },
    [`POST /api/rooms/${r.id}/messages`]: { status: 201, body: message({ roomId: r.id, seq: 4, author: ME, body: 'my reply', threadRootId: root.id, alsoInRoom: true }) },
  }
  serve()
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  const m = await mount(<ThreadPanel roomId={r.id} rootId={root.id} roomTitle="acme-design" members={[ME, BEN, CY]} meId={ME.id} onClose={() => {}} />)
  try {
    await m.until(() => m.find('thread-count'), 'the thread')
    const html = m.html()
    expect(html.indexOf('THE ROOT')).toBeLessThan(html.indexOf('first reply'))
    expect(m.get('thread-count').textContent).toBe(translate('en', 'rooms.threadReplies', { n: 2 }))
    expect(m.get('thread-room').textContent).toBe('acme-design')
    // the root has no thread line of its own here
    expect(m.find('room-thread-line')).toBeNull()
    // the reply box: its placeholder and the one choice
    expect(m.get('room-input').getAttribute('placeholder')).toBe(translate('en', 'rooms.threadPlaceholder'))
    expect(m.get('room-also-in-room').textContent).toContain(translate('en', 'rooms.alsoToRoom'))
    await m.type('room-input', 'my reply')
    // a click on a checkbox turns it on before its listeners run (past React's value tracker, as typing does)
    const box = m.get('room-also-in-room').querySelector('input')!
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!.set!.call(box, true)
    await m.click(box as never)
    await m.click('room-send')
    await m.until(() => calls.some((c) => c.method === 'POST' && c.path === `/api/rooms/${r.id}/messages`), 'the send')
    const sent = calls.find((c) => c.method === 'POST' && c.path === `/api/rooms/${r.id}/messages`)!.body as Record<string, unknown>
    expect(sent).toMatchObject({ body: 'my reply', threadRootId: root.id, alsoInRoom: true })
    await m.until(() => useRooms.getState().threadView?.replies.length === 3, 'my reply in the thread')
    // the choice is off again for the next reply
    expect((m.get('room-also-in-room').querySelector('input') as unknown as { checked: boolean }).checked).toBe(false)
  } finally {
    await m.unmount()
  }
})

test('the end of the thread in sight marks it read once per position', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  const r = room({ threadsUnread: 1 })
  const root = message({ roomId: r.id, seq: 1, author: ME, body: 'mine', thread: { replyCount: 1, lastReplyAt: at(2), repliers: [BEN], newReplies: true } })
  routes = {
    [`GET /api/rooms/${r.id}/messages/${root.id}/thread`]: { body: { root, items: [message({ roomId: r.id, seq: 2, body: 'reply', threadRootId: root.id })], nextCursor: null } },
    [`POST /api/rooms/${r.id}/messages/${root.id}/thread/read`]: { body: { lastReadSeq: 2, room: { ...r, threadsUnread: 0 } } },
  }
  serve()
  ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => true
  ;(document as unknown as { visibilityState: string }).visibilityState = 'visible'
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  const m = await mount(<ThreadPanel roomId={r.id} rootId={root.id} roomTitle="acme" members={[ME, BEN]} meId={ME.id} onClose={() => {}} />)
  try {
    await m.until(() => calls.some((c) => c.path.endsWith('/thread/read')), 'the read')
    window.dispatchEvent(new FakeEvent('focus') as never)
    await m.settle(30)
    expect(calls.filter((c) => c.path.endsWith('/thread/read')).map((c) => c.body)).toEqual([{ seq: 2 }])
    expect(useRooms.getState().rooms[0]!.threadsUnread).toBe(0)
  } finally {
    await m.unmount()
  }
})

test('in the phone app the thread on screen is read though its WebView reports no focus; a browser window without focus reads nothing', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  const r = room({ threadsUnread: 1 })
  const root = message({ roomId: r.id, seq: 1, author: ME, body: 'mine', thread: { replyCount: 1, lastReplyAt: at(2), repliers: [BEN], newReplies: true } })
  routes = {
    [`GET /api/rooms/${r.id}/messages/${root.id}/thread`]: { body: { root, items: [message({ roomId: r.id, seq: 2, body: 'reply', threadRootId: root.id })], nextCursor: null } },
    [`POST /api/rooms/${r.id}/messages/${root.id}/thread/read`]: { body: { lastReadSeq: 2, room: { ...r, threadsUnread: 0 } } },
  }
  serve()
  const g = globalThis as unknown as Record<string, unknown>
  ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => false
  ;(document as unknown as { visibilityState: string }).visibilityState = 'visible'
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  const m = await mount(<ThreadPanel roomId={r.id} rootId={root.id} roomTitle="acme" members={[ME, BEN]} meId={ME.id} onClose={() => {}} />)
  try {
    await m.until(() => m.find('room-thread') && !useRooms.getState().threadView?.loading, 'the thread')
    await m.settle(30)
    expect(calls.filter((c) => c.path.endsWith('/thread/read'))).toEqual([])
    // the same page inside the phone app (its bridge is there): on screen is looking at it
    g.mycelMobile = { protocol: 1, appVersion: '0.4.0', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
    g.ReactNativeWebView = { postMessage: () => {} }
    document.dispatchEvent(new FakeEvent('visibilitychange') as never)
    await m.until(() => calls.some((c) => c.path.endsWith('/thread/read')), 'the read')
    await m.until(() => useRooms.getState().rooms[0]!.threadsUnread === 0, 'the badge')
    expect(calls.filter((c) => c.path.endsWith('/thread/read')).map((c) => c.body)).toEqual([{ seq: 2 }])
  } finally {
    delete g.mycelMobile
    delete g.ReactNativeWebView
    await m.unmount()
  }
})

test('a thread I cannot see (joined after its root, or gone) says so, with no box', async () => {
  const r = room()
  const rootId = uuidv7()
  routes = {}
  serve()
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  const m = await mount(<ThreadPanel roomId={r.id} rootId={rootId} roomTitle="acme" members={[ME]} meId={ME.id} onClose={() => {}} />)
  try {
    await m.until(() => m.find('thread-not-found'), 'not found')
    expect(m.get('thread-not-found').textContent).toBe(translate('en', 'rooms.threadNotFound'))
    expect(m.find('room-input')).toBeNull()
  } finally {
    await m.unmount()
  }
})
