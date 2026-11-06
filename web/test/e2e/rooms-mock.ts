// One team chat room for the e2e specs (the mock server lists no rooms: test/mock/server.ts listRooms): its REST answers
// through page.route, contract-shaped, and the messages sent to it kept for the spec to read. The signed-in owner (olga)
// is a member; the others are people of this room only (not in the directory).
import type { Page } from '@playwright/test'

export const ROOM_ID = '019a5f00-0000-7000-8000-00000000a001'
const T0 = Date.parse('2026-11-05T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
let seq = 100

export interface MockRoom {
  /** the bodies of POST /api/rooms/:id/messages, in order */
  sent: { body: string; mentions: string[]; threadRootId?: string | null }[]
}

export async function routeRoom(page: Page, o: { members: { id: string; name: string }[]; messages?: { id: string; author: { id: string; name: string }; body: string; mentions?: string[] }[] }): Promise<MockRoom> {
  const state: MockRoom = { sent: [] }
  const members = [{ id: 'olga', name: 'Olga' }, ...o.members]
  const message = (m: { id: string; author: { id: string; name: string } | null; body: string; mentions?: string[] }, n: number) => ({
    id: m.id, roomId: ROOM_ID, seq: n, authorKind: 'user', author: m.author, askedBy: null, visibility: 'room', body: m.body, replyTo: null,
    mentions: m.mentions ?? [], files: [], createdAt: at(n), editedAt: null, deletedAt: null,
  })
  const messages = (o.messages ?? []).map((m, i) => message(m, i + 1))
  const room = {
    id: ROOM_ID, kind: 'group', name: '디자인 리뷰', canRename: true, managerId: 'olga', groupId: null, memberCount: members.length,
    peers: o.members.slice(0, 4), lastSeq: messages.length, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false,
    lastReadSeq: messages.length, lastMessage: null, muted: false, createdAt: at(-60), activityAt: at(messages.length),
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const method = req.method()
    if (method === 'GET' && path === '/api/rooms') return route.fulfill(json({ items: [room] }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}`) return route.fulfill(json(room))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/messages`) return route.fulfill(json({ items: messages, nextCursor: null }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/members`) return route.fulfill(json({ items: members.map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && path === `/api/rooms/${ROOM_ID}/ai`) return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'POST' && path === `/api/rooms/${ROOM_ID}/read`) return route.fulfill(json({ lastReadSeq: room.lastSeq, unreadCount: 0, mentioned: false }))
    const thread = /^\/api\/rooms\/[^/]+\/messages\/([^/]+)\/thread(\/read)?$/.exec(path)
    const root = thread && messages.find((m) => m.id === thread[1])
    if (thread && root && method === 'GET' && !thread[2]) return route.fulfill(json({ root, items: [], nextCursor: null }))
    if (thread && root && method === 'POST' && thread[2]) return route.fulfill(json({ lastReadSeq: room.lastSeq, room }))
    if (method === 'POST' && path === `/api/rooms/${ROOM_ID}/messages`) {
      const b = req.postDataJSON() as MockRoom['sent'][number]
      state.sent.push(b)
      const n = ++seq
      const id = `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
      return route.fulfill(json(message({ id, author: { id: 'olga', name: 'Olga' }, body: b.body, mentions: b.mentions }, n), 201))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return state
}
